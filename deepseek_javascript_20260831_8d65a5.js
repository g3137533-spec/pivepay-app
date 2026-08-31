// server.js
require('dotenv').config({ path: './env.txt' });  // loads from env.txt if present, fallback to .env

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');   // for timing‑safe comparison

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

// ⚠️ CRITICAL: Raw body for webhook MUST be registered BEFORE express.json()
app.use('/api/webhook/flutterwave', express.raw({ type: 'application/json' }));

// Then the regular body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ------------------------------
//  Helper Functions
// ------------------------------
function generateTxId(prefix = 'TX') {
  return `${prefix}-${Date.now()}-${uuidv4().slice(0, 6)}`;
}

// Timing‑safe signature verification
function verifySignature(received, secret) {
  const a = Buffer.from(received || '');
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ------------------------------
//  Routes
// ------------------------------

// -------- VTU Proxy (example with VTPass) --------
app.post('/api/vtu-proxy', async (req, res) => {
  try {
    const { userId, serviceId, amount, phone, planName, type, metadata } = req.body;

    if (!userId || !serviceId || !amount) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // Replace with your actual VTU provider call.
    // Example using VTPass (uncomment and adapt):
    /*
    const vtuPayload = {
      serviceID: serviceId,
      amount: amount,
      phone: phone,
      request_id: generateTxId('VTU'),
    };
    const vtuResponse = await axios.post(
      `${process.env.VTU_BASE_URL}/pay`,
      vtuPayload,
      { headers: { 'api-key': process.env.VTU_API_KEY, 'Content-Type': 'application/json' } }
    );
    if (vtuResponse.data.code !== '000') throw new Error(vtuResponse.data.desc || 'VTU failed');
    */

    // Simulate success for demo
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
      basePrice: amount,
      commissionRate: 0,
    });

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

    // Step 2: Pull user record
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return res.redirect('/#deposit?kyc=error');
    const user = userSnap.data();

    // Step 3: Create a permanent virtual account
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
        txRef: txRef,
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
      meta: { uid },
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
  // ✅ Immediately acknowledge receipt to prevent Flutterwave timeouts.
  // Firestore work will happen asynchronously.
  res.send('Webhook received');

  // Process the webhook payload in the background.
  try {
    const signature = req.headers['verif-hash'];
    // Timing‑safe signature check
    if (!verifySignature(signature, process.env.FLW_WEBHOOK_SECRET)) {
      console.error('Webhook signature mismatch');
      return;
    }

    // Parse raw body (already parsed by express.raw)
    const payload = typeof req.body === 'string' || Buffer.isBuffer(req.body)
      ? JSON.parse(req.body)
      : req.body;

    const { tx_ref, status, amount, transaction_id, currency, account_number } = payload.data || {};
    const eventType = payload['event.type'];

    if (payload.event !== 'charge.completed' || status !== 'successful') {
      return; // ignore other events
    }

    // Handle virtual account bank transfers (eventType === 'BANK_TRANSFER_TRANSACTION')
    // or regular card/redirect payments (eventType undefined or other)
    if (eventType === 'BANK_TRANSFER_TRANSACTION') {
      // Idempotency: check if this transaction_id already processed
      const dupCheck = await db.collection('transactions')
        .where('flutterwaveTransactionId', '==', transaction_id)
        .limit(1)
        .get();

      if (!dupCheck.empty) {
        console.log(`Duplicate webhook for tx_id ${transaction_id} ignored.`);
        return;
      }

      // Match by virtual account's tx_ref (permanent) or account_number
      let userDoc = null;
      const usersByRef = await db.collection('users')
        .where('virtualAccount.txRef', '==', tx_ref)
        .limit(1)
        .get();

      if (!usersByRef.empty) {
        userDoc = usersByRef.docs[0];
      } else if (account_number) {
        // Fallback: match by account_number
        const usersByAcc = await db.collection('users')
          .where('virtualAccount.accountNumber', '==', account_number)
          .limit(1)
          .get();
        if (!usersByAcc.empty) {
          userDoc = usersByAcc.docs[0];
        }
      }

      if (!userDoc) {
        console.error('No user found for bank transfer webhook:', { tx_ref, account_number });
        return;
      }

      // Credit the user
      await userDoc.ref.update({
        walletBalance: admin.firestore.FieldValue.increment(amount),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Record transaction
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

      console.log(`Bank transfer processed: ${transaction_id}`);

    } else {
      // Regular card/redirect payment
      const txSnapshot = await db.collection('transactions')
        .where('transactionId', '==', tx_ref)
        .limit(1)
        .get();

      if (txSnapshot.empty) {
        console.error('Transaction not found for ref:', tx_ref);
        return;
      }

      const doc = txSnapshot.docs[0];
      const data = doc.data();

      // Idempotency check
      if (data.status === 'success') {
        console.log(`Transaction ${tx_ref} already processed.`);
        return;
      }

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

        console.log(`Card/redirect payment processed: ${tx_ref}`);
      }
    }
  } catch (error) {
    console.error('Webhook processing error:', error);
  }
});

// -------- Serve static frontend (if using public folder) --------
app.use(express.static('public'));

// Catch-all: serve index.html for all other routes (SPA support)
app.get('*', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
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