const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;

if (supabaseUrl && supabaseServiceKey) {
  supabase = createClient(supabaseUrl, supabaseServiceKey);
  console.log('Supabase client initialized successfully.');
} else {
  console.warn('Supabase credentials missing in .env');
}

// Initialize Nodemailer SMTP Transporter
let mailTransporter = null;
if (process.env.SMTP_HOST) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  console.log('Nodemailer SMTP transporter initialized.');
} else {
  console.warn('SMTP configuration missing in .env. Email dispatch disabled.');
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cache for access token
let cachedToken = null;
let tokenExpiresAt = 0;

// Save refresh token back to .env
function saveRefreshToken(refreshToken) {
  const envPath = path.join(__dirname, '.env');
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }
  
  if (envContent.includes('GOOGLE_ADS_REFRESH_TOKEN=')) {
    envContent = envContent.replace(/GOOGLE_ADS_REFRESH_TOKEN=.*/, `GOOGLE_ADS_REFRESH_TOKEN=${refreshToken}`);
  } else {
    envContent += `\nGOOGLE_ADS_REFRESH_TOKEN=${refreshToken}`;
  }
  fs.writeFileSync(envPath, envContent, 'utf8');
  process.env.GOOGLE_ADS_REFRESH_TOKEN = refreshToken;
  console.log('Refresh token saved to .env successfully.');
}

// Get Access Token using OAuth2 Refresh Token
async function getAccessToken() {
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('MISSING_CREDENTIALS');
  }

  // Check cache
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  try {
    const response = await axios.post('https://oauth2.googleapis.com/token', null, {
      params: {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      },
    });

    cachedToken = response.data.access_token;
    // Expires in response.data.expires_in seconds (usually 3600), subtract 60s for safety
    tokenExpiresAt = Date.now() + (response.data.expires_in - 60) * 1000;
    return cachedToken;
  } catch (error) {
    console.error('Error refreshing access token:', error.response?.data || error.message);
    throw new Error('AUTH_FAILED');
  }
}

// 1. Status API
app.get('/api/status', (req, res) => {
  res.json({
    hasClientId: !!process.env.GOOGLE_ADS_CLIENT_ID,
    hasClientSecret: !!process.env.GOOGLE_ADS_CLIENT_SECRET,
    hasDeveloperToken: !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    hasMccId: !!process.env.GOOGLE_ADS_MCC_ID,
    hasRefreshToken: !!process.env.GOOGLE_ADS_REFRESH_TOKEN,
  });
});

// 2. Start OAuth2 Flow
app.get('/auth', (req, res) => {
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  if (!clientId) {
    return res.status(400).send('GOOGLE_ADS_CLIENT_ID is not configured in .env');
  }

  const redirectUri = process.env.GOOGLE_ADS_REDIRECT_URI || `http://localhost:${PORT}/oauth2callback`;
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(clientId)}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent('https://www.googleapis.com/auth/adwords')}&` +
    `access_type=offline&` +
    `prompt=consent`;

  res.redirect(authUrl);
});

// 3. OAuth2 Callback Handler
app.get('/oauth2callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    return res.status(400).send(`OAuth Error: ${error}`);
  }
  if (!code) {
    return res.status(400).send('Authorization code missing.');
  }

  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_ADS_REDIRECT_URI || `http://localhost:${PORT}/oauth2callback`;

  try {
    const response = await axios.post('https://oauth2.googleapis.com/token', null, {
      params: {
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      },
    });

    const refreshToken = response.data.refresh_token;
    if (refreshToken) {
      saveRefreshToken(refreshToken);
      res.redirect('/?auth=success');
    } else {
      // Sometimes Google does not return a refresh token if prompt=consent was not forced or already authorized
      res.send('Authorization succeeded, but no refresh token was returned. Please try re-authenticating and make sure to accept all permissions.');
    }
  } catch (error) {
    console.error('Error exchanging code:', error.response?.data || error.message);
    res.status(500).send(`Authentication failed: ${JSON.stringify(error.response?.data || error.message)}`);
  }
});

// 4. Get Child Accounts from MCC
app.get('/api/accounts', async (req, res) => {
  const mccId = process.env.GOOGLE_ADS_MCC_ID;
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const apiVersion = process.env.GOOGLE_ADS_API_VERSION || 'v24';

  if (!mccId || !developerToken) {
    return res.status(400).json({ error: 'MCC Customer ID and Developer Token are required.' });
  }

  try {
    const accessToken = await getAccessToken();

    // GAQL Query to fetch children
    const query = `
      SELECT
        customer_client.id,
        customer_client.descriptive_name,
        customer_client.currency_code,
        customer_client.status
      FROM customer_client
      WHERE customer_client.status = 'ENABLED'
        AND customer_client.manager = false
        AND customer_client.level > 0
    `;

    const response = await axios.post(
      `https://googleads.googleapis.com/${apiVersion}/customers/${mccId}/googleAds:search`,
      { query },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': developerToken,
          'login-customer-id': mccId,
        },
      }
    );

    const accounts = (response.data.results || []).map(row => {
      const client = row.customerClient;
      return {
        id: client.id,
        name: client.descriptiveName || `Conta ${client.id}`,
        currencyCode: client.currencyCode,
        status: client.status,
      };
    });

    // Sync accounts with Supabase "Contas" table asynchronously
    if (supabase && accounts.length > 0) {
      (async () => {
        try {
          const { data: existing, error: fetchErr } = await supabase.from('Contas').select('id_conta, nome_conta');
          if (fetchErr) throw fetchErr;

          const existingMap = new Map(existing.map(row => [row.id_conta, row.nome_conta]));
          const toInsert = [];
          const toUpdate = [];

          for (const acc of accounts) {
            if (!existingMap.has(acc.id)) {
              toInsert.push({ id_conta: acc.id, nome_conta: acc.name });
            } else if (existingMap.get(acc.id) !== acc.name) {
              toUpdate.push({ id_conta: acc.id, nome_conta: acc.name });
            }
          }

          if (toInsert.length > 0) {
            const { error: insErr } = await supabase.from('Contas').insert(toInsert);
            if (insErr) console.error('Error inserting accounts to Supabase:', insErr);
          }

          for (const upd of toUpdate) {
            const { error: updErr } = await supabase.from('Contas').update({ nome_conta: upd.nome_conta }).eq('id_conta', upd.id_conta);
            if (updErr) console.error('Error updating account name in Supabase:', updErr);
          }

          console.log(`Supabase Sync: Inserted ${toInsert.length}, Updated ${toUpdate.length} accounts.`);
        } catch (err) {
          console.error('Error during Supabase accounts sync:', err.message);
        }
      })();
    }

    res.json({ accounts });
  } catch (error) {
    console.error('Error listing child accounts:', error.response?.data || error.message);
    res.status(500).json({
      error: error.message,
      details: error.response?.data || 'Erro de conexão com o Google Ads API.'
    });
  }
});

// 5. Get Account Budget for a Specific Child Account
app.get('/api/account-budget/:customerId', async (req, res) => {
  const { customerId } = req.params;
  const mccId = process.env.GOOGLE_ADS_MCC_ID;
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const apiVersion = process.env.GOOGLE_ADS_API_VERSION || 'v24';

  if (!customerId) {
    return res.status(400).json({ error: 'Customer ID is required.' });
  }

  try {
    const accessToken = await getAccessToken();

    // Date range for current calendar month
    const now = new Date();
    const startOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const endOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    // Query 1: Monthly Cost
    const costQuery = `
      SELECT metrics.cost_micros
      FROM customer
      WHERE segments.date BETWEEN '${startOfMonth}' AND '${endOfMonth}'
    `;

    // Query 1.5: Today's Cost
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const todayCostQuery = `
      SELECT metrics.cost_micros
      FROM customer
      WHERE segments.date = '${todayStr}'
    `;

    // Query 1.8: Enabled Campaigns Daily Budgets
    const campaignQuery = `
      SELECT campaign_budget.amount_micros
      FROM campaign
      WHERE campaign.status = 'ENABLED'
    `;

    // Query 2: Billing Setup (Payment Account Name)
    const billingQuery = `
      SELECT
        billing_setup.payments_account_info.payments_account_name
      FROM billing_setup
      WHERE billing_setup.status = 'APPROVED'
    `;

    // Query 3: Account Budget (Invoiced Budgets)
    const budgetQuery = `
      SELECT
        account_budget.id,
        account_budget.name,
        account_budget.status,
        account_budget.approved_spending_limit_micros,
        account_budget.approved_spending_limit_type,
        account_budget.amount_served_micros,
        account_budget.approved_start_date_time,
        account_budget.approved_end_date_time
      FROM account_budget
      WHERE account_budget.status = 'APPROVED'
    `;

    // Run queries in parallel, catching individual failures
    const [costRes, todayCostRes, campaignRes, billingRes, budgetRes] = await Promise.all([
      axios.post(
        `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/googleAds:search`,
        { query: costQuery },
        { headers: { 'Authorization': `Bearer ${accessToken}`, 'developer-token': developerToken, 'login-customer-id': mccId } }
      ).catch(err => { console.warn(`Cost query failed for ${customerId}:`, err.message); return null; }),

      axios.post(
        `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/googleAds:search`,
        { query: todayCostQuery },
        { headers: { 'Authorization': `Bearer ${accessToken}`, 'developer-token': developerToken, 'login-customer-id': mccId } }
      ).catch(err => { console.warn(`Today's cost query failed for ${customerId}:`, err.message); return null; }),

      axios.post(
        `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/googleAds:search`,
        { query: campaignQuery },
        { headers: { 'Authorization': `Bearer ${accessToken}`, 'developer-token': developerToken, 'login-customer-id': mccId } }
      ).catch(err => { console.warn(`Campaign query failed for ${customerId}:`, err.message); return null; }),

      axios.post(
        `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/googleAds:search`,
        { query: billingQuery },
        { headers: { 'Authorization': `Bearer ${accessToken}`, 'developer-token': developerToken, 'login-customer-id': mccId } }
      ).catch(err => { console.warn(`Billing query failed for ${customerId}:`, err.message); return null; }),

      axios.post(
        `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/googleAds:search`,
        { query: budgetQuery },
        { headers: { 'Authorization': `Bearer ${accessToken}`, 'developer-token': developerToken, 'login-customer-id': mccId } }
      ).catch(err => { console.warn(`Budget query failed for ${customerId}:`, err.message); return null; })
    ]);

    // 1. Process Monthly Cost
    let monthlySpent = 0;
    if (costRes && costRes.data.results?.[0]?.metrics?.costMicros) {
      monthlySpent = parseFloat(costRes.data.results[0].metrics.costMicros) / 1000000;
    }

    // 1.5. Process Daily Cost
    let dailySpent = 0;
    if (todayCostRes && todayCostRes.data.results?.[0]?.metrics?.costMicros) {
      dailySpent = parseFloat(todayCostRes.data.results[0].metrics.costMicros) / 1000000;
    }

    // 1.8. Process Scheduled Daily Budget
    let scheduledDailyBudget = 0;
    if (campaignRes && campaignRes.data.results && campaignRes.data.results.length > 0) {
      campaignRes.data.results.forEach(row => {
        if (row.campaignBudget?.amountMicros) {
          scheduledDailyBudget += parseFloat(row.campaignBudget.amountMicros) / 1000000;
        }
      });
    }

    // 2. Process Budget & Remaining Balance
    let remaining = null;
    let limit = null;
    let budgetSpent = null;
    let isInfinite = false;
    let hasActiveBudget = false;
    let startDate = null;

    if (budgetRes && budgetRes.data.results && budgetRes.data.results.length > 0) {
      const budgetRows = budgetRes.data.results;
      const budgetNow = new Date();
      
      const activeBudgets = budgetRows.map(row => {
        const b = row.accountBudget;
        return {
          id: b.id,
          approvedLimitMicros: b.approvedSpendingLimitMicros,
          approvedLimitType: b.approvedSpendingLimitType,
          amountServedMicros: b.amountServedMicros,
          startDateTime: b.approvedStartDateTime,
          endDateTime: b.approvedEndDateTime
        };
      }).filter(b => {
        if (b.startDateTime) {
          const start = new Date(b.startDateTime);
          if (start > budgetNow) return false;
        }
        if (b.endDateTime && b.endDateTime !== 'FOREVER' && b.endDateTime !== 'UNDETECTED') {
          const end = new Date(b.endDateTime);
          if (end < budgetNow) return false;
        }
        return true;
      });

      // Sort by startDateTime descending to get the most recent one first
      activeBudgets.sort((a, b) => {
        const dateA = a.startDateTime ? new Date(a.startDateTime) : new Date(0);
        const dateB = b.startDateTime ? new Date(b.startDateTime) : new Date(0);
        return dateB - dateA;
      });

      if (activeBudgets.length > 0) {
        hasActiveBudget = true;
        const active = activeBudgets[0];
        isInfinite = active.approvedLimitType === 'INFINITE';
        limit = isInfinite ? null : parseFloat(active.approvedLimitMicros) / 1000000;
        budgetSpent = parseFloat(active.amountServedMicros) / 1000000;
        remaining = isInfinite ? null : limit - budgetSpent;
        startDate = active.startDateTime;
      }
    }

    // 3. Process Payment Method
    let paymentMethod = hasActiveBudget ? 'Faturamento Consolidado' : 'Cartão / Boleto / Pix';
    if (billingRes && billingRes.data.results?.[0]?.billingSetup?.paymentsAccountInfo?.paymentsAccountName) {
      const name = billingRes.data.results[0].billingSetup.paymentsAccountInfo.paymentsAccountName;
      const lowerName = name.toLowerCase();
      
      if (lowerName.includes('boleto')) {
        paymentMethod = 'Boleto';
      } else if (lowerName.includes('cartao') || lowerName.includes('cartão') || lowerName.includes('credit') || lowerName.includes('card')) {
        paymentMethod = 'Cartão de Crédito';
      } else if (lowerName.includes('pix')) {
        paymentMethod = 'Pix';
      } else if (hasActiveBudget) {
        paymentMethod = 'Faturamento Consolidado';
      } else {
        paymentMethod = name; // If it's another name, show it directly
      }
    }

    res.json({
      paymentMethod,
      monthlySpent,
      dailySpent,
      scheduledDailyBudget,
      remaining,
      limit,
      budgetSpent,
      isInfinite,
      startDate
    });

  } catch (error) {
    console.error(`Error querying data for customer ${customerId}:`, error.response?.data || error.message);
    res.status(500).json({
      error: error.message,
      details: error.response?.data || 'Erro ao processar dados da conta.'
    });
  }
});

// 6. Get Responsibles joined with Accounts (supporting multiple contacts)
app.get('/api/responsibles', async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase client is not configured.' });
  }

  try {
    const [contasRes, respRes] = await Promise.all([
      supabase.from('Contas').select('id_conta, nome_conta'),
      supabase.from('Responsaveis').select('id, nome, email, telefone, id_conta')
    ]);

    if (contasRes.error) throw contasRes.error;
    if (respRes.error) throw respRes.error;

    // Group contacts by id_conta
    const respMap = new Map();
    (respRes.data || []).forEach(r => {
      if (!respMap.has(r.id_conta)) {
        respMap.set(r.id_conta, []);
      }
      respMap.get(r.id_conta).push({
        id: r.id,
        nome: r.nome,
        email: r.email,
        telefone: r.telefone
      });
    });

    const responsiblesList = (contasRes.data || []).map(c => {
      return {
        id_conta: c.id_conta,
        nome_conta: c.nome_conta,
        contacts: respMap.get(c.id_conta) || []
      };
    });

    res.json({ responsibles: responsiblesList });
  } catch (error) {
    console.error('Error fetching responsibles:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 7. Create or Update a Responsible Contact
app.post('/api/responsibles', async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase client is not configured.' });
  }

  const { id, id_conta, nome, email, telefone } = req.body;

  if (!id_conta || !nome) {
    return res.status(400).json({ error: 'id_conta and nome are required fields.' });
  }

  try {
    if (id) {
      // Update existing contact by its primary ID
      const { error: updErr } = await supabase
        .from('Responsaveis')
        .update({ nome, email, telefone })
        .eq('id', id);

      if (updErr) throw updErr;
      res.json({ success: true, message: 'Responsável atualizado com sucesso.' });
    } else {
      // Insert new contact for the account
      const { error: insErr } = await supabase
        .from('Responsaveis')
        .insert({ id_conta, nome, email, telefone });

      if (insErr) throw insErr;
      res.json({ success: true, message: 'Responsável cadastrado com sucesso.' });
    }
  } catch (error) {
    console.error('Error saving responsible:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 8. Delete a Responsible Contact
app.delete('/api/responsibles/:id', async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase client is not configured.' });
  }

  const { id } = req.params;

  try {
    const { error: delErr } = await supabase
      .from('Responsaveis')
      .delete()
      .eq('id', id);

    if (delErr) throw delErr;
    res.json({ success: true, message: 'Responsável excluído com sucesso.' });
  } catch (error) {
    console.error('Error deleting responsible:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 9. Send Automatic Notifications (WhatsApp via Evolution API and/or E-mail via Nodemailer)
app.post('/api/notify', async (req, res) => {
  const { id_responsavel, channels, subject, message } = req.body;

  if (!id_responsavel || !channels || !Array.isArray(channels) || channels.length === 0) {
    return res.status(400).json({ error: 'id_responsavel and channels (array) are required fields.' });
  }

  try {
    // 1. Fetch contact details from Supabase
    const { data: contact, error: fetchErr } = await supabase
      .from('Responsaveis')
      .select('*')
      .eq('id', id_responsavel)
      .single();

    if (fetchErr || !contact) {
      return res.status(404).json({ error: 'Responsável não encontrado.' });
    }

    const results = {};

    // 2. Send via WhatsApp
    if (channels.includes('whatsapp')) {
      const evolutionUrl = process.env.EVOLUTION_API_URL;
      const evolutionKey = process.env.EVOLUTION_API_KEY;
      const evolutionInstance = process.env.EVOLUTION_INSTANCE;

      if (!evolutionUrl || !evolutionKey || !evolutionInstance) {
        results.whatsapp = { success: false, error: 'Evolution API credentials missing on server.' };
      } else if (!contact.telefone) {
        results.whatsapp = { success: false, error: 'Responsável não possui telefone cadastrado.' };
      } else {
        try {
          // Format phone number: remove non-digits
          let phoneClean = contact.telefone.replace(/\D/g, '');
          // If 10 or 11 digits (Brazilian number without DDI), prepend '55'
          if (phoneClean.length === 10 || phoneClean.length === 11) {
            phoneClean = '55' + phoneClean;
          }

          const response = await axios.post(
            `${evolutionUrl}/message/sendText/${evolutionInstance}`,
            {
              number: phoneClean,
              textMessage: {
                text: message
              },
              delay: 1200
            },
            {
              headers: {
                'apikey': evolutionKey,
                'Content-Type': 'application/json'
              }
            }
          );

          results.whatsapp = { success: true, response: response.data };
        } catch (err) {
          console.error('Error sending WhatsApp message:', err.response?.data || err.message);
          results.whatsapp = { 
            success: false, 
            error: err.response?.data?.message || err.message 
          };
        }
      }
    }

    // 3. Send via E-mail
    if (channels.includes('email')) {
      if (!mailTransporter) {
        results.email = { success: false, error: 'SMTP configurations missing on server.' };
      } else if (!contact.email) {
        results.email = { success: false, error: 'Responsável não possui e-mail cadastrado.' };
      } else {
        try {
          const mailOptions = {
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: contact.email,
            subject: subject || 'Alerta de Saldo Google Ads',
            text: message
          };

          const info = await mailTransporter.sendMail(mailOptions);
          results.email = { success: true, messageId: info.messageId };
        } catch (err) {
          console.error('Error sending email:', err.message);
          results.email = { success: false, error: err.message };
        }
      }
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error('Notification error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
