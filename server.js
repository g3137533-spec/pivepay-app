// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// ------------------------------
//  Firebase Admin Initialization
// ------------------------------
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('FATAL: FIREBASE_SERVICE_ACCOUNT environment variable not set.');
  process.exit(1);
}
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
} catch (e) {
  console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:', e.message);
  process.exit(1);
}
const db = admin.firestore();

// ------------------------------
//  Express App
// ------------------------------
const app = express();

// Enable CORS for all origins (adjust in production)
app.use(cors());

// Body parsers
app.use(express.json());                // for regular API requests
app.use(express.urlencoded({ extended: true }));

// Webhook must use raw body for signature verification
app.use('/api/webhook/flutterwave', express.raw({ type: 'application/json' }));

// ------------------------------
//  Helper Functions
// ------------------------------
function generateTxId(prefix = 'TX') {
  return `${prefix}-${Date.now()}-${uuidv4().slice(0, 6)}`;
}

// ------------------------------
//  Routes
// ------------------------------

// -------- VTU Proxy (example with VTPass) --------
app.post('/api/vtu-proxy', async (req, res) => {
  try {
    const { userId, serviceId, amount, phone, planName, type, metadata } = req.body;

    // Validate input
    if (!userId || !serviceId || !amount) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // In a real implementation, you would call your VTU provider API here.
    // Example with VTPass (https://vtpass.com/api):
    const vtuPayload = {
      serviceID: serviceId,
      amount: amount,
      phone: phone,
      request_id: generateTxId('VTU'),
      // ... other fields depending on provider
    };

    // Replace with your provider's endpoint and auth.
    // const vtuResponse = await axios.post(
    //   `${process.env.VTU_BASE_URL}/pay`,
    //   vtuPayload,
    //   { headers: { 'api-key': process.env.VTU_API_KEY, 'Content-Type': 'application/json' } }
    // );

    // For demo, simulate success
    const transactionId = generateTxId('VTU');

    // Record transaction in Firestore
    await db.collection('transactions').add({
      userId,
      type,
      service: planName || 'VTU',
      amount,
      reference: transactionId,
      status: 'success',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      metadata: { serviceId, phone, ...metadata },
      basePrice: amount, // or from your pricing logic
      commissionRate: 0, // adjust if needed
    });

    // Credit referral if applicable (already handled on frontend? Possibly not, but we can trigger)
    // You might call a function to check referral qualification separately.

    res.json({ success: true, transactionId });
  } catch (error) {
    console.error('VTU Proxy Error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data?.message || error.message });
  }
});

// -------- KYC Initiate (BVN) --------
app.post('/api/kyc-initiate', async (req, res) => {
  try {
    const { bvn, firstname, lastname, uid } = req.body;

    if (!bvn || bvn.length !== 11) {
      return res.status(400).json({ success: false, error: 'BVN must be exactly 11 digits' });
    }

    const bvnResponse = await axios.post(
      'https://api.flutterwave.com/v3/bvn/verifications',
      {
        bvn,
        firstname,
        lastname,
        redirect_url: `${process.env.BASE_URL}/api/kyc-callback?uid=${uid}`
      },
      { headers: { 'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`, 'Content-Type': 'application/json' } }
    );

    const respData = bvnResponse.data;

    if (respData.status === 'success') {
      const consentUrl = respData.data?.url;
      res.json({
        success: true,
        consent_url: consentUrl || null,
        reference: respData.data?.reference,
        already_consented: !consentUrl
      });
    } else {
      throw new Error(respData.message || 'BVN initiation failed');
    }
  } catch (error) {
    console.error('BVN Init Error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data?.message || error.message });
  }
});

// -------- KYC Callback (BVN verification + Virtual Account creation) --------
app.get('/api/kyc-callback', async (req, res) => {
  try {
    const { uid, reference } = req.query;
    if (!uid || !reference) return res.redirect('/#deposit?kyc=error');

    // Step 1: Verify BVN consent
    const verifyResponse = await axios.get(
      `https://api.flutterwave.com/v3/bvn/verifications/${reference}`,
      { headers: { 'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}` } }
    );

    const bvnData = verifyResponse.data?.data;
    const isVerified = verifyResponse.data?.status === 'success' && bvnData?.status === 'COMPLETED';

    if (!isVerified) return res.redirect('/#deposit?kyc=failed');

    // Step 2: Pull user record so we have their details for the virtual account
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return res.redirect('/#deposit?kyc=error');
    const user = userSnap.data();

    // Step 3: Create a permanent virtual account using their confirmed BVN
    const txRef = generateTxId('VA');
    const vaResponse = await axios.post(
      'https://api.flutterwave.com/v3/virtual-account-numbers',
      {
        email: user.email,
        tx_ref: txRef,
        phonenumber: user.phone || bvnData?.bvn_data?.phoneNumber2 || '00000000000',
        is_permanent: true,
        firstname: user.firstname || bvnData?.bvn_data?.firstName,
        lastname: user.lastname || bvnData?.bvn_data?.surname,
        narration: `${user.firstname || ''} ${user.lastname || ''}`.trim(),
        bvn: bvnData?.bvn_data?.bvn
      },
      { headers: { 'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`, 'Content-Type': 'application/json' } }
    );

    const vaData = vaResponse.data?.data;

    // Step 4: Save everything to Firestore
    await db.collection('users').doc(uid).update({
      kycVerified: true,
      kycReference: reference,
      bvnData: bvnData?.bvn_data || {},
      virtualAccount: {
        accountNumber: vaData?.account_number,
        bankName: vaData?.bank_name,
        narration: vaData?.note,
        txRef: txRef, // important for webhook matching
        createdAt: new Date().toISOString()
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.redirect('/#deposit?kyc=success');

  } catch (error) {
    console.error('BVN Callback Error:', error.response?.data || error.message);
    return res.redirect('/#deposit?kyc=error');
  }
});

// -------- Initiate Payment (Flutterwave standard checkout) --------
app.post('/api/initiate-payment', async (req, res) => {
  try {
    const { amount, email, name, uid } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({ success: false, error: 'Amount must be at least ₦100' });
    }
    if (!email || !uid) {
      return res.status(400).json({ success: false, error: 'Missing user details' });
    }

    const txRef = generateTxId('DEP');
    const redirectUrl = `${process.env.BASE_URL}/#deposit?status=success`;

    // Create a pending transaction record
    await db.collection('transactions').add({
      userId: uid,
      type: 'wallet',
      amount: amount,
      transactionId: txRef,
      status: 'pending',
      paymentMethod: 'flutterwave',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Initialize Flutterwave payment
    const payload = {
      tx_ref: txRef,
      amount,
      currency: 'NGN',
      redirect_url: redirectUrl,
      customer: { email, name: name || 'User' },
      customizations: { title: 'PIVEPAY Wallet Funding', logo: 'https://your-logo-url.com/logo.png' },
      meta: { uid }, // optional
    };

    const response = await axios.post(
      'https://api.flutterwave.com/v3/payments',
      payload,
      { headers: { 'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`, 'Content-Type': 'application/json' } }
    );

    if (response.data.status === 'success') {
      res.json({ success: true, data: { link: response.data.data.link } });
    } else {
      throw new Error(response.data.message || 'Payment initiation failed');
    }
  } catch (error) {
    console.error('Payment Init Error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data?.message || error.message });
  }
});

// -------- Webhook for Flutterwave --------
app.post('/api/webhook/flutterwave', async (req, res) => {
  try {
    const signature = req.headers['verif-hash'];
    if (signature !== process.env.FLW_WEBHOOK_SECRET) {
      return res.status(401).send('Unauthorized');
    }

    // Parse raw body
    const payload = typeof req.body === 'string' || Buffer.isBuffer(req.body)
      ? JSON.parse(req.body)
      : req.body;

    const { tx_ref, status, amount, transaction_id, currency } = payload.data || {};
    const eventType = payload['event.type'];

    // Handle both card payments and virtual account bank transfers
    if (payload.event === 'charge.completed' && status === 'successful') {

      if (eventType === 'BANK_TRANSFER_TRANSACTION') {
        // Virtual account funding — match user by their virtual account tx_ref
        const usersSnap = await db.collection('users')
          .where('virtualAccount.txRef', '==', tx_ref)
          .limit(1)
          .get();

        if (!usersSnap.empty) {
          const userDoc = usersSnap.docs[0];
          await userDoc.ref.update({
            walletBalance: admin.firestore.FieldValue.increment(amount),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          await db.collection('transactions').add({
            transactionId: tx_ref,
            userId: userDoc.id,
            type: 'deposit',
            amount,
            currency: currency || 'NGN',
            status: 'success',
            flutterwaveTransactionId: transaction_id,
            paymentMethod: 'bank_transfer',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
          await db.collection('activities').add({
            userId: userDoc.id,
            type: 'payment',
            description: `Wallet funded with ₦${amount} via bank transfer`,
            metadata: { tx_ref, transaction_id },
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
        }

      } else {
        // Regular card/link payment — match by transactionId in transactions collection
        const txSnapshot = await db.collection('transactions')
          .where('transactionId', '==', tx_ref)
          .limit(1).get();

        if (!txSnapshot.empty) {
          const doc = txSnapshot.docs[0];
          const data = doc.data();
          if (data.status === 'pending') {
            await doc.ref.update({
              status: 'success',
              flutterwaveTransactionId: transaction_id,
              completedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            await db.collection('users').doc(data.userId).update({
              walletBalance: admin.firestore.FieldValue.increment(amount),
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            await db.collection('activities').add({
              userId: data.userId,
              type: 'payment',
              description: `Wallet funded with ₦${amount} via Flutterwave`,
              metadata: { tx_ref, transaction_id },
              timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        }
      }
    }

    res.send('Webhook processed');
  } catch (error) {
    console.error('Webhook Error:', error);
    res.status(500).send('Webhook error');
  }
});

// -------- Health Check (optional) --------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// -------- Start Server --------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Backend server running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Base URL: ${process.env.BASE_URL || 'not set'}`);
});