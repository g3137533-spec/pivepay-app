# PIVEPAY – VTU & Payment Platform

A full-featured virtual top-up (VTU) and bill payment platform built with **Node.js**, **Express**, **Firebase** (Auth & Firestore), and **Flutterwave** for payments.  
The frontend is a single-page HTML/CSS/JS application with a modern, dark-themed UI.

---

## 🚀 Features

- **Secure Authentication** – Firebase Auth (email/password)
- **Virtual Account** – Permanent BVN‑linked virtual accounts via Flutterwave
- **Wallet Funding** – Card, Bank Transfer, and USSD using Flutterwave
- **VTU Services** – Airtime, Data (all networks), Cable TV (DSTV, GOTV, Startimes), Electricity, Education (WAEC, NECO, NABTEB), Talk More, Showmax
- **Multi-Level Referral Program** – Earn ₦50 (Level 1), ₦20 (Level 2), ₦10 (Level 3) per verified referral
- **Admin Dashboard** – Manage users, transactions, services, staff, notifications, and referral withdrawals
- **Real‑time Webhooks** – Auto‑credit wallets on payment confirmation
- **Professional Receipts** – Unique transaction IDs and status

---

## 🛠️ Tech Stack

### Frontend
- HTML5, Tailwind CSS, Remixicon
- Vanilla JavaScript (SPA)
- Firebase JS SDK (Auth, Firestore)

### Backend
- Node.js + Express
- Firebase Admin SDK
- Axios (HTTP requests)
- Flutterwave API (payments, BVN, virtual accounts)
- VTU Provider API (e.g., VTPass)

### Deployment
- Render (Web Service)
- GitHub for version control

---

## 📦 Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/pivepay.git
   cd pivepay