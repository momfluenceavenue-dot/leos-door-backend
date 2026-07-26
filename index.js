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

// TEMPORARY DEBUG ROUTE — safe to leave in briefly, shows only a partial
// masked view of the key actually loaded at runtime, never the full secret.
// Remove this route once the key mismatch is confirmed fixed.
app.get('/debug-key', (req, res) => {
  const key = process.env.STRIPE_SECRET_KEY || '';
  res.json({
    keyPrefix: key.slice(0, 30),
    keyLast4: key.slice(-4),
    keyLength: key.length,
    mode: key.startsWith('sk_test_') ? 'TEST' : key.startsWith('sk_live_') ? 'LIVE' : 'UNKNOWN',
  });
});

// TEMPORARY DEBUG ROUTE — asks Gelato directly what page counts are valid
// for your exact product, instead of guessing from rejected orders.
app.get('/debug-gelato-product', async (req, res) => {
  try {
    const productUid = process.env.GELATO_PRODUCT_UID;
    const response = await fetch(`https://product.gelatoapis.com/v3/products/${productUid}`, {
      headers: { 'X-API-KEY': process.env.GELATO_API_KEY },
    });
    const data = await response.json();
    res.json({
      productUid,
      validPageCounts: data.validPageCounts || 'not returned by Gelato for this product',
      productStatus: data.attributes ? data.attributes.ProductStatus : undefined,
      raw: data,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
EMAIL_USER = leosdoorbooks@gmail.com
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
      public_id: `book-${Date.now()}.pdf`,
      use_filename: false,
      unique_filename: false,
    });

    res.json({ pdfUrl: result.secure_url });
  } catch (err) {
    console.error('PDF upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
// ROUTE 3B: SUBMIT LULU PRINT ORDER
// Sends the cover + interior PDFs and shipping info to Lulu.
// Lulu uses OAuth2 (client_key + client_secret) instead of a simple API key,
// so we first fetch a temporary access token, then submit the print job.
// ═══════════════════════════════════════════════════════

const LULU_BASE_URL = process.env.LULU_USE_SANDBOX === 'true'
  ? 'https://api.sandbox.lulu.com'
  : 'https://api.lulu.com';

async function getLuluAccessToken() {
  const authUrl = process.env.LULU_USE_SANDBOX === 'true'
    ? 'https://api.sandbox.lulu.com/auth/realms/glasstree/protocol/openid-connect/token'
    : 'https://api.lulu.com/auth/realms/glasstree/protocol/openid-connect/token';

  const basicAuth = Buffer.from(`${process.env.LULU_CLIENT_KEY}:${process.env.LULU_CLIENT_SECRET}`).toString('base64');

  const res = await fetch(authUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Lulu auth failed: ${errText}`);
  }
  const data = await res.json();
  return data.access_token;
}

app.post('/submit-lulu-order', async (req, res) => {
  try {
    const {
      orderReferenceId,
      customerReferenceId,
      childName,
      rooms,
      power,
      pdfUrl,
      coverUrl,
      shippingAddress,
    } = req.body;

    const accessToken = await getLuluAccessToken();

    const luluPayload = {
      contact_email: process.env.EMAIL_USER,
      external_id: orderReferenceId,
      line_items: [{
        external_id: `${orderReferenceId}-BOOK`,
        printable_normalization: {
          cover: { source_url: coverUrl },
          interior: { source_url: pdfUrl },
          pod_package_id: process.env.LULU_POD_PACKAGE_ID,
        },
        quantity: 1,
        title: `${childName}'s Door`,
      }],
      shipping_address: {
        name: `${shippingAddress.firstName} ${shippingAddress.lastName}`,
        street1: shippingAddress.addressLine1,
        street2: shippingAddress.addressLine2 || '',
        city: shippingAddress.city,
        state_code: (shippingAddress.state || '').trim().toUpperCase(),
        postcode: shippingAddress.postCode,
        country_code: shippingAddress.country || 'US',
        phone_number: shippingAddress.phone || '0000000000',
        email: shippingAddress.email,
      },
      shipping_level: 'MAIL',
    };

    const luluRes = await fetch(`${LULU_BASE_URL}/print-jobs/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(luluPayload),
    });

    if (!luluRes.ok) {
      const errBody = await luluRes.text();
      throw new Error(`Lulu API error: ${errBody}`);
    }

    const luluOrder = await luluRes.json();

    await sendConfirmationEmail(shippingAddress, childName, luluOrder.id);

    res.json({ luluOrderId: luluOrder.id, success: true });
  } catch (err) {
    console.error('Lulu error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// TEMPORARY DEBUG ROUTE — verifies your Lulu credentials and pod_package_id
// actually work, before you rely on them for a real order.
app.get('/debug-lulu-package', async (req, res) => {
  try {
    const accessToken = await getLuluAccessToken();
    const podPackageId = process.env.LULU_POD_PACKAGE_ID;
    const dimsRes = await fetch(`${LULU_BASE_URL}/cover-dimensions/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pod_package_id: podPackageId,
        interior_page_count: 30,
        unit: 'pt',
      }),
    });
    const dimsData = await dimsRes.json();
    res.json({
      podPackageId,
      tokenReceived: !!accessToken,
      coverDimensionsResponse: dimsData,
      usingSandbox: process.env.LULU_USE_SANDBOX === 'true',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
// ROUTE 3: SUBMIT GELATO ORDER (kept for reference / fallback)
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
      coverUrl,
      pageCount,
      shippingAddress,
    } = req.body;

    const files = [{ type: 'default', url: pdfUrl }];
    if (coverUrl) {
      files.push({ type: 'cover', url: coverUrl });
    }

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
        pageCount: pageCount || 28, // Confirmed valid minimum via Gelato's own product API (validPageCounts)
        quantity: 1,
        files: files,
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
        state: (shippingAddress.state || '').trim().toUpperCase(),
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
            <a href="https://leosdoor.com" style="background:#5B2C8D;color:white;text-decoration:none;padding:12px 28px;border-radius:50px;font-size:14px;">
              Visit leosdoor.com
            </a>
          </div>
          <p style="text-align:center;font-size:12px;color:#999;margin-top:20px;">
            Questions? Email us at leosdoorbooks@gmail.com<br>
            Leo's Door Books · leosdoor.com
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
