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
  try {
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }
    
    if (envContent.includes('GOOGLE_ADS_REFRESH_TOKEN=')) {
      envContent = envContent.replace(/GOOGLE_ADS_REFRESH_TOKEN=.*/, `GOOGLE_ADS_REFRESH_TOKEN=${refreshToken}`);
    } else {
      envContent += `\nGOOGLE_ADS_REFRESH_TOKEN=${refreshToken}`;
    }
    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log('Refresh token saved to .env successfully.');
  } catch (error) {
    console.warn('Warning: Could not save refresh token to .env (this is expected on read-only filesystems like Vercel):', error.message);
  }
  process.env.GOOGLE_ADS_REFRESH_TOKEN = refreshToken;
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

// Helper to fetch budget details for a child account (used by API and Cron)
async function getAccountBudgetData(customerId, accessToken, developerToken, mccId) {
  const apiVersion = process.env.GOOGLE_ADS_API_VERSION || 'v24';

  const campaignQuery = `
    SELECT campaign_budget.amount_micros
    FROM campaign
    WHERE campaign.status = 'ENABLED'
  `;

  const budgetQuery = `
    SELECT
      account_budget.id,
      account_budget.name,
      account_budget.status,
      account_budget.approved_spending_limit_micros,
      account_budget.approved_spending_limit_type,
      account_budget.adjusted_spending_limit_micros,
      account_budget.adjusted_spending_limit_type,
      account_budget.amount_served_micros,
      account_budget.approved_start_date_time,
      account_budget.approved_end_date_time
    FROM account_budget
    WHERE account_budget.status = 'APPROVED'
  `;

  try {
    const [campaignRes, budgetRes] = await Promise.all([
      axios.post(
        `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/googleAds:search`,
        { query: campaignQuery },
        { headers: { 'Authorization': `Bearer ${accessToken}`, 'developer-token': developerToken, 'login-customer-id': mccId } }
      ).catch(err => { console.warn(`Campaign query failed for ${customerId}:`, err.message); return null; }),

      axios.post(
        `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/googleAds:search`,
        { query: budgetQuery },
        { headers: { 'Authorization': `Bearer ${accessToken}`, 'developer-token': developerToken, 'login-customer-id': mccId } }
      ).catch(err => { console.warn(`Budget query failed for ${customerId}:`, err.message); return null; })
    ]);

    let scheduledDailyBudget = 0;
    if (campaignRes && campaignRes.data.results && campaignRes.data.results.length > 0) {
      const seenBudgets = new Set();
      campaignRes.data.results.forEach(row => {
        const budget = row.campaignBudget;
        if (budget && budget.amountMicros) {
          const budgetRef = budget.resourceName || budget.id || `unknown_${Math.random()}`;
          if (!seenBudgets.has(budgetRef)) {
            seenBudgets.add(budgetRef);
            scheduledDailyBudget += parseFloat(budget.amountMicros) / 1000000;
          }
        }
      });
    }

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
          adjustedLimitMicros: b.adjustedSpendingLimitMicros,
          adjustedLimitType: b.adjustedSpendingLimitType,
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
        const limitType = active.adjustedLimitType || active.approvedLimitType;
        const limitMicros = active.adjustedLimitMicros || active.approvedLimitMicros;
        
        isInfinite = limitType === 'INFINITE';
        limit = isInfinite ? null : parseFloat(limitMicros) / 1000000;
        budgetSpent = parseFloat(active.amountServedMicros) / 1000000;
        remaining = isInfinite ? null : limit - budgetSpent;
        startDate = active.startDateTime;
      }
    }

    return { remaining, limit, budgetSpent, isInfinite, hasActiveBudget, startDate, scheduledDailyBudget };
  } catch (err) {
    console.error(`Error in getAccountBudgetData for ${customerId}:`, err.message);
    return { remaining: null, limit: null, budgetSpent: null, isInfinite: false, hasActiveBudget: false, startDate: null, scheduledDailyBudget: 0 };
  }
}

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

    // Query 2: Billing Setup (Payment Account Name)
    const billingQuery = `
      SELECT
        billing_setup.payments_account_info.payments_account_name
      FROM billing_setup
      WHERE billing_setup.status = 'APPROVED'
    `;

    // Run queries in parallel, catching individual failures
    const [costRes, todayCostRes, billingRes, budgetData] = await Promise.all([
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
        { query: billingQuery },
        { headers: { 'Authorization': `Bearer ${accessToken}`, 'developer-token': developerToken, 'login-customer-id': mccId } }
      ).catch(err => { console.warn(`Billing query failed for ${customerId}:`, err.message); return null; }),

      getAccountBudgetData(customerId, accessToken, developerToken, mccId)
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

    const { remaining, limit, budgetSpent, isInfinite, hasActiveBudget, startDate, scheduledDailyBudget } = budgetData;

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

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

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
    try {
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
            let phoneClean = String(contact.telefone || '').replace(/\D/g, '');
            // If 10 or 11 digits (Brazilian number without DDI), prepend '55'
            if (phoneClean.length === 10 || phoneClean.length === 11) {
              phoneClean = '55' + phoneClean;
            }

            const response = await axios.post(
              `${evolutionUrl}/message/sendText/${evolutionInstance}`,
              {
                number: phoneClean,
                text: message,
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
    } catch (whatsappOuterError) {
      console.error('Unhandled WhatsApp error:', whatsappOuterError);
      results.whatsapp = { success: false, error: whatsappOuterError.message };
    }

    // 3. Send via E-mail
    try {
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
    } catch (emailOuterError) {
      console.error('Unhandled E-mail error:', emailOuterError);
      results.email = { success: false, error: emailOuterError.message };
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error('Notification error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 10. Helper function to check all child account budgets and notify low budget (<= 10 days) accounts
async function checkAndNotifyLowBudgets() {
  console.log('[Scheduler] Starting checkAndNotifyLowBudgets...');
  if (!supabase) {
    console.warn('[Scheduler] Supabase client missing. Skipping budget check.');
    return { success: false, error: 'Supabase client missing' };
  }

  try {
    const accessToken = await getAccessToken();
    const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    const mccId = process.env.GOOGLE_ADS_MCC_ID;

    // Fetch accounts and responsibles in parallel
    const [contasRes, respRes] = await Promise.all([
      supabase.from('Contas').select('id_conta, nome_conta'),
      supabase.from('Responsaveis').select('id, nome, email, telefone, id_conta')
    ]);

    if (contasRes.error) throw contasRes.error;
    if (respRes.error) throw respRes.error;

    const accounts = contasRes.data || [];
    if (accounts.length === 0) {
      console.log('[Scheduler] No accounts found in database.');
      return { success: true, count: 0 };
    }

    // Create a map of account responsibles
    const responsiblesMap = new Map();
    (respRes.data || []).forEach(r => {
      if (!responsiblesMap.has(r.id_conta)) {
        responsiblesMap.set(r.id_conta, []);
      }
      responsiblesMap.get(r.id_conta).push(r);
    });

    console.log(`[Scheduler] Checking budgets for ${accounts.length} accounts...`);

    const evolutionUrl = process.env.EVOLUTION_API_URL;
    const evolutionKey = process.env.EVOLUTION_API_KEY;
    const evolutionInstance = process.env.EVOLUTION_INSTANCE;

    // Batch accounts to prevent API rate limiting and timeouts (batch size = 5)
    const batchSize = 5;
    const alertResults = [];

    for (let i = 0; i < accounts.length; i += batchSize) {
      const batch = accounts.slice(i, i + batchSize);
      await Promise.all(batch.map(async (account) => {
        try {
          const budgetData = await getAccountBudgetData(account.id_conta, accessToken, developerToken, mccId);
          const { remaining, scheduledDailyBudget, isInfinite } = budgetData;

          if (isInfinite) return;
          if (remaining === null) return; // Skip if no active invoiced budget (or prepay card/boleto/pix)

          let days = 0;
          if (scheduledDailyBudget > 0) {
            days = remaining / scheduledDailyBudget;
          } else {
            // Remaining balance is set but daily budget is 0, so days is infinite (no spend)
            return;
          }

          if (days <= 10) {
            const responsibles = responsiblesMap.get(account.id_conta) || [];
            if (responsibles.length === 0) {
              console.log(`[Scheduler] Account ${account.nome_conta} (${account.id_conta}) has low budget (${days.toFixed(1)} days left) but no responsibles.`);
              return;
            }

            console.log(`[Scheduler] Account ${account.nome_conta} (${account.id_conta}) is critical: ${days.toFixed(1)} days left. Sending alerts to ${responsibles.length} responsibles...`);

            // Format values for the template message
            const formattedRemaining = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(remaining);
            const formattedDays = days < 0 ? '0 dias' : `${Math.floor(days)} dias`;

            for (const resp of responsibles) {
              const templateMessage = `Olá ${resp.nome} o saldo restante na conta ${account.nome_conta} é de ${formattedRemaining}, Temos mais ${formattedDays} de saldo`;
              const subject = `Alerta de Saldo Baixo - Google Ads: ${account.nome_conta}`;

              const results = { contact: resp.nome, account: account.nome_conta, channels: {} };

              // Send WhatsApp
              if (evolutionUrl && evolutionKey && evolutionInstance && resp.telefone) {
                try {
                  let phoneClean = String(resp.telefone || '').replace(/\D/g, '');
                  if (phoneClean.length === 10 || phoneClean.length === 11) {
                    phoneClean = '55' + phoneClean;
                  }
                  await axios.post(
                    `${evolutionUrl}/message/sendText/${evolutionInstance}`,
                    { number: phoneClean, text: templateMessage, delay: 1200 },
                    { headers: { 'apikey': evolutionKey, 'Content-Type': 'application/json' } }
                  );
                  results.channels.whatsapp = { success: true };
                } catch (err) {
                  console.error(`[Scheduler] Failed WhatsApp alert for ${resp.nome}:`, err.message);
                  results.channels.whatsapp = { success: false, error: err.message };
                }
              }

              // Send Email
              if (mailTransporter && resp.email) {
                try {
                  const mailOptions = {
                    from: process.env.SMTP_FROM || process.env.SMTP_USER,
                    to: resp.email,
                    subject: subject,
                    text: templateMessage
                  };
                  await mailTransporter.sendMail(mailOptions);
                  results.channels.email = { success: true };
                } catch (err) {
                  console.error(`[Scheduler] Failed Email alert for ${resp.nome}:`, err.message);
                  results.channels.email = { success: false, error: err.message };
                }
              }

              alertResults.push(results);
            }
          }
        } catch (err) {
          console.error(`[Scheduler] Failed checking budget for account ${account.id_conta}:`, err.message);
        }
      }));
    }

    console.log('[Scheduler] checkAndNotifyLowBudgets completed successfully.');
    return { success: true, processed: accounts.length, alerts: alertResults };
  } catch (error) {
    console.error('[Scheduler] Error in checkAndNotifyLowBudgets:', error.message);
    return { success: false, error: error.message };
  }
}

// 11. Cron trigger endpoint (daily low budget notifications check)
app.get('/api/cron/check-budgets', async (req, res) => {
  const isVercel = process.env.VERCEL === '1';
  const isCronHeader = req.headers['x-vercel-cron'] === '1';
  
  if (isVercel && !isCronHeader) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await checkAndNotifyLowBudgets();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 12. Local cron trigger (runs daily in background when running as a persistent Node server)
if (process.env.VERCEL !== '1') {
  // Wait 10 seconds after server startup before running the initial check
  setTimeout(async () => {
    console.log('[Scheduler] Running initial local startup budget check...');
    await checkAndNotifyLowBudgets().catch(err => {
      console.error('[Scheduler] Initial startup check failed:', err.message);
    });
  }, 10000);

  // Function to schedule the next check at exactly 8:00 AM local time
  function scheduleDailyAlert() {
    const now = new Date();
    let target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0, 0, 0); // 8:00 AM today
    
    if (now >= target) {
      // If it's already past 8:00 AM today, schedule for 8:00 AM tomorrow
      target.setDate(target.getDate() + 1);
    }
    
    const delay = target.getTime() - now.getTime();
    console.log(`[Scheduler] Next local budget check scheduled for ${target.toString()} (in ${(delay / 1000 / 60).toFixed(1)} minutes)`);
    
    setTimeout(async () => {
      console.log('[Scheduler] Running scheduled local budget check at 8:00 AM...');
      await checkAndNotifyLowBudgets().catch(err => {
        console.error('[Scheduler] Scheduled check failed:', err.message);
      });
      // Schedule the next day's alert
      scheduleDailyAlert();
    }, delay);
  }

  // Start the scheduling loop
  scheduleDailyAlert();
}

// Start Server
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
}

module.exports = app;
