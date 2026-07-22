// ═══════════════════════════════════════════════════════
// LEO'S DOOR — Backend Server
// Deploy to Vercel (free)
// Handles: Stripe payments · PDF hosting · Gelato orders
// ═══════════════════════════════════════════════════════
// ── INSTALL DEPENDENCIES ──
// npm install express stripe @aws-sdk/client-s3 multer cors dotenv nodemailer

const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const multer = require('multer');
const nodemailer = require('nodemailer');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(cors({ origin: '*' }));
app.use(express.json());

// ═══════════════════════════════════════════════════════
// ENV VARIABLES — set these in Vercel dashboard
// or create a .env file locally
// ═══════════════════════════════════════════════════════
/*
STRIPE_SECRET_KEY = sk_live_... (from stripe.com)
GELATO_API_KEY = your-gelato-key (from gelato.com dashboard)
GELATO_PRODUCT_UID = photobook_hardcover_landscape_210x210
PDF_STORAGE_BASE_URL = https://your-s3-bucket.s3.amazonaws.com
AWS_ACCESS_KEY_ID = ... (for PDF hosting — or use Cloudinary free tier)
AWS_SECRET_ACCESS_KEY = ...
AWS_BUCKET_NAME = leos-door-pdfs
EMAIL_USER = hello@leorsdoor.com
EMAIL_PASS = your-email-app-password
WEBHOOK_SECRET = whsec_... (from Stripe dashboard)
*/

// ═══════════════════════════════════════════════════════
// ROUTE 1: CREATE STRIPE PAYMENT INTENT
// Called when customer clicks "Pay" in the app
// ═══════════════════════════════════════════════════════
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency, metadata } = req.body;
    const paymentIntent = await stripe.paymentIntents.create({
      amount, // in cents — 3999 = $39.99
      currency, // 'usd'
      metadata, // childName, rooms, power, customerEmail
      automatic_payment_methods: { enabled: true },
      description: `Leo's Door — Custom Book for ${metadata?.childName || 'Child'}`,
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
// ROUTE 2: UPLOAD PERSONALIZED PDF
// Stores the generated PDF temporarily so Gelato can fetch it
// Uses Cloudinary (free tier, no billing/card required)
// ═══════════════════════════════════════════════════════
app.post('/upload-pdf', upload.single('file'), async (req, res) => {
  try {
    const b64 = Buffer.from(req.file.buffer).toString('base64');
    const dataURI = `data:${req.file.mimetype};base64,${b64}`;

    const result = await cloudinary.uploader.upload(dataURI, {
      resource_type: 'raw',
      folder: 'leos-door-books',
      public_id: `book-${Date.now()}`,
    });

    res.json({ pdfUrl: result.secure_url });
  } catch (err) {
    console.error('PDF upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
// ROUTE 3: SUBMIT GELATO ORDER
// Sends the print-ready PDF + shipping info to Gelato
// Gelato prints, binds, and ships the book automatically
// ═══════════════════════════════════════════════════════
app.post('/submit-gelato-order', async (req, res) => {
  try {
    const {
      orderReferenceId,
      customerReferenceId,
      paymentId,
      childName,
      rooms,
      power,
      pdfUrl,
      shippingAddress,
    } = req.body;

    const gelatoPayload = {
      orderType: 'order',
      orderReferenceId,
      customerReferenceId,
      currency: 'USD',
      // ── PRODUCT ──────────────────────────────
      // Set your exact Gelato product UID in the dashboard
      items: [{
        itemReferenceId: `${orderReferenceId}-BOOK`,
        productUid: process.env.GELATO_PRODUCT_UID,
        quantity: 1,
        files: [{
          type: 'default',
          url: pdfUrl, // Your publicly accessible PDF URL
        }],
        // Custom metadata visible in Gelato dashboard
        metadata: [
          { key: 'childName', value: childName },
          { key: 'rooms', value: rooms.join(', ') },
          { key: 'power', value: power },
        ]
      }],
      // ── SHIPPING ─────────────────────────────
      shipmentMethodUid: 'standard', // or 'express' for faster delivery
      shippingAddress: {
        firstName: shippingAddress.firstName,
        lastName: shippingAddress.lastName,
        addressLine1: shippingAddress.addressLine1,
        addressLine2: shippingAddress.addressLine2 || '',
        city: shippingAddress.city,
        state: shippingAddress.state,
        postCode: shippingAddress.postCode,
        country: shippingAddress.country,
        email: shippingAddress.email,
      },
    };

    // ── CALL GELATO API ───────────────────────
    // NOTE: fixed — "body" now lives inside the fetch options object
    const gelatoRes = await fetch('https://order.gelatoapis.com/v4/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': process.env.GELATO_API_KEY,
      },
      body: JSON.stringify(gelatoPayload),
    });

    if (!gelatoRes.ok) {
      const errBody = await gelatoRes.json();
      throw new Error(`Gelato API error: ${JSON.stringify(errBody)}`);
    }

    const gelatoOrder = await gelatoRes.json();

    // ── SEND CONFIRMATION EMAIL ───────────────
    await sendConfirmationEmail(shippingAddress, childName, gelatoOrder.id);

    res.json({ gelatoOrderId: gelatoOrder.id, success: true });
  } catch (err) {
    console.error('Gelato error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
// ROUTE 4: STRIPE WEBHOOK
// Handles payment confirmation from Stripe server-side
// Set webhook URL in Stripe dashboard → your-backend.vercel.app/webhook
// ═══════════════════════════════════════════════════════
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle successful payment
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    console.log(`Payment succeeded for ${pi.metadata?.childName} — ${pi.id}`);
    // You can trigger additional actions here (Klaviyo email, Slack notification, etc.)
  }

  res.json({ received: true });
});

// ═══════════════════════════════════════════════════════
// ROUTE 5: GELATO WEBHOOK (Order Status Updates)
// Gelato will POST to this URL when order status changes
// Set in Gelato dashboard → Webhooks → Add URL
// ═══════════════════════════════════════════════════════
app.post('/gelato-webhook', async (req, res) => {
  const { orderId, fulfillmentStatus, shipment } = req.body;
  console.log(`Gelato update — Order ${orderId}: ${fulfillmentStatus}`);

  if (fulfillmentStatus === 'shipped' && shipment?.trackingCode) {
    // Send shipping confirmation email to customer
    // You'll need to look up customer email by orderId from your database
    console.log(`Tracking: ${shipment.trackingCode} via ${shipment.shipmentMethodName}`);
    // TODO: sendShippingEmail(customerEmail, shipment.trackingCode)
  }

  res.json({ received: true });
});

// ═══════════════════════════════════════════════════════
// EMAIL — Confirmation email sent after order
// ═══════════════════════════════════════════════════════
async function sendConfirmationEmail(shipping, childName, gelatoOrderId) {
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS, // Use Gmail App Password
      }
    });

    await transporter.sendMail({
      from: `"Leo's Door Books" <${process.env.EMAIL_USER}>`,
      to: shipping.email,
      subject: `${childName}'s Book is Being Printed!`,
      html: `
        <!DOCTYPE html>
        <html>
        <body style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:24px;background:#F5F0FA;">
          <div style="background:linear-gradient(135deg,#3A1A6E,#5B2C8D);border-radius:18px;padding:32px;text-align:center;margin-bottom:18px;">
            <h1 style="color:#D4A017;font-size:28px;font-style:italic;margin:0 0 8px;">
              ${childName}'s Door
            </h1>
            <p style="color:rgba(255,255,255,.8);font-size:15px;margin:0;">is on its way!</p>
          </div>
          <div style="background:white;border-radius:16px;padding:28px;margin-bottom:18px;">
            <h2 style="color:#5B2C8D;font-size:18px;margin:0 0 16px;">Hi ${shipping.firstName},</h2>
            <p style="color:#333;line-height:1.7;margin:0 0 14px;">
              We're so excited to tell you that <strong>${childName}'s</strong> personalized book
              is now being printed and bound, just for them!
            </p>
            <div style="background:#F9F4FF;border-radius:12px;padding:16px;margin:16px 0;">
              <div style="font-size:12px;font-weight:700;color:#5B2C8D;letter-spacing:1px;">ORDER DETAILS</div>
              <div style="font-size:14px;color:#333;">Order ID: <strong>${gelatoOrderId}</strong></div>
              <div style="font-size:14px;color:#333;margin-top:6px;">Estimated delivery: 5-7 days</div>
              <div style="font-size:14px;color:#333;margin-top:6px;">Shipping to: ${shipping.city}, ${shipping.state}</div>
            </div>
            <p style="color:#555;font-size:14px;line-height:1.6;margin:0;">
              When your book ships, you'll receive another email with a tracking number
              so you can follow ${childName}'s book all the way to your door!
            </p>
          </div>
          <div style="background:linear-gradient(135deg,rgba(91,44,141,.08),rgba(212,160,23,.08));border-radius:12px;padding:16px;font-size:13px;color:#555;text-align:center;margin-bottom:18px;">
            This book was created in memory of <strong>Amarie</strong> (Aug 22, 2017 - Mar 9, 2021),
            a PICU child who showed us that imagination has no walls.
            Every book we send carries her spirit into the hands of a child who needs it.
          </div>
          <div style="text-align:center;padding:16px 0;">
            <a href="https://leorsdoor.com" style="background:#5B2C8D;color:white;text-decoration:none;padding:12px 28px;border-radius:50px;font-size:14px;">
              Visit leorsdoor.com
            </a>
          </div>
          <p style="text-align:center;font-size:12px;color:#999;margin-top:20px;">
            Questions? Email us at hello@leorsdoor.com<br>
            Leo's Door Books · leorsdoor.com
          </p>
        </body>
        </html>
      `,
    });
    console.log(`Confirmation email sent to ${shipping.email}`);
  } catch (err) {
    console.error('Email error:', err.message);
    // Don't throw — email failure shouldn't break the order
  }
}

// ═══════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Leo's Door backend running on port ${PORT}`));

module.exports = app; // Required for Vercel serverless deployment
