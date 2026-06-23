document.addEventListener('DOMContentLoaded', () => {
  const connectionStatus = document.getElementById('connection-status');
  const authSection = document.getElementById('auth-section');
  const dashboardSection = document.getElementById('dashboard-section');
  const mccInfo = document.getElementById('mcc-info');
  const btnRefresh = document.getElementById('btn-refresh');
  const tbody = document.getElementById('accounts-tbody');
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  const responsiblesTbody = document.getElementById('responsibles-tbody');

  // Modal Elements
  const editModal = document.getElementById('edit-modal');
  const modalClose = document.getElementById('modal-close');
  const btnCancel = document.getElementById('btn-cancel');
  const editForm = document.getElementById('edit-form');
  const modalIdConta = document.getElementById('modal-id-conta');
  const modalIdResponsavel = document.getElementById('modal-id-responsavel');
  const modalIdContaDisplay = document.getElementById('modal-id-conta-display');
  const modalNomeContaDisplay = document.getElementById('modal-nome-conta-display');
  const inputNome = document.getElementById('input-nome');
  const inputEmail = document.getElementById('input-email');
  const inputTelefone = document.getElementById('input-telefone');

  // Notify Modal Elements
  const notifyModal = document.getElementById('notify-modal');
  const notifyModalClose = document.getElementById('notify-modal-close');
  const btnNotifyCancel = document.getElementById('btn-notify-cancel');
  const notifyForm = document.getElementById('notify-form');
  const notifyIdConta = document.getElementById('notify-id-conta');
  const notifyIdResponsavel = document.getElementById('notify-id-responsavel');
  const notifyContactDisplay = document.getElementById('notify-contact-display');
  const chkWhatsapp = document.getElementById('chk-whatsapp');
  const chkEmail = document.getElementById('chk-email');
  const groupSubject = document.getElementById('group-subject');
  const notifySubject = document.getElementById('notify-subject');
  const notifyMessage = document.getElementById('notify-message');

  // Notify Checkbox Toggle
  chkEmail.addEventListener('change', () => {
    if (chkEmail.checked) {
      groupSubject.style.display = 'block';
    } else {
      groupSubject.style.display = 'none';
    }
  });

  // Notify Modal Event Listeners
  notifyModalClose.addEventListener('click', closeNotifyModal);
  btnNotifyCancel.addEventListener('click', closeNotifyModal);
  notifyModal.addEventListener('click', (e) => {
    if (e.target === notifyModal) {
      closeNotifyModal();
    }
  });

  // Handle Notification Form Submission
  notifyForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const submitBtn = notifyForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;

    const channels = [];
    if (chkWhatsapp.checked) channels.push('whatsapp');
    if (chkEmail.checked) channels.push('email');

    if (channels.length === 0) {
      alert('Selecione pelo menos um canal de envio (WhatsApp ou E-mail).');
      return;
    }

    submitBtn.textContent = 'Enviando...';
    submitBtn.disabled = true;

    const payload = {
      id_responsavel: parseInt(notifyIdResponsavel.value),
      channels,
      subject: notifySubject.value.trim(),
      message: notifyMessage.value.trim()
    };

    try {
      const response = await fetch('/api/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const resData = await response.json();
      
      let feedback = 'Status do Envio:\n';
      if (resData.results.whatsapp) {
        feedback += `- WhatsApp: ${resData.results.whatsapp.success ? 'Enviado!' : 'Erro: ' + resData.results.whatsapp.error}\n`;
      }
      if (resData.results.email) {
        feedback += `- E-mail: ${resData.results.email.success ? 'Enviado!' : 'Erro: ' + resData.results.email.error}\n`;
      }

      alert(feedback);
      closeNotifyModal();
    } catch (error) {
      console.error('Error sending notification:', error);
      alert(`Erro ao enviar notificação: ${error.message}`);
    } finally {
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
    }
  });

  // Tab switching
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.add('hidden'));

      btn.classList.add('active');
      const targetTab = btn.getAttribute('data-tab');
      document.getElementById(`tab-content-${targetTab}`).classList.remove('hidden');

      if (targetTab === 'responsibles') {
        loadResponsibles();
      }
    });
  });

  // Modal Event Listeners
  modalClose.addEventListener('click', closeEditModal);
  btnCancel.addEventListener('click', closeEditModal);
  editModal.addEventListener('click', (e) => {
    if (e.target === editModal) {
      closeEditModal();
    }
  });

  // Handle Form Submission
  editForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const submitBtn = editForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Salvando...';
    submitBtn.disabled = true;

    const payload = {
      id: modalIdResponsavel.value ? parseInt(modalIdResponsavel.value) : null,
      id_conta: modalIdConta.value,
      nome: inputNome.value.trim(),
      email: inputEmail.value.trim(),
      telefone: inputTelefone.value.trim()
    };

    try {
      const response = await fetch('/api/responsibles', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      closeEditModal();
      loadResponsibles(); // Reload list
    } catch (error) {
      console.error('Error saving responsible:', error);
      alert(`Erro ao salvar responsável: ${error.message}`);
    } finally {
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
    }
  });

  // Check auth status
  checkStatus();

  btnRefresh.addEventListener('click', () => {
    // Refresh the currently active tab data
    const activeTab = document.querySelector('.tab-btn.active').getAttribute('data-tab');
    if (activeTab === 'saldos') {
      loadDashboard();
    } else {
      loadResponsibles();
    }
  });

  async function checkStatus() {
    try {
      const response = await fetch('/api/status');
      const data = await response.json();

      if (data.hasRefreshToken) {
        connectionStatus.textContent = 'Conectado ao Google Ads';
        connectionStatus.className = 'status-badge success';
        authSection.classList.add('hidden');
        dashboardSection.classList.remove('hidden');
        loadDashboard();
      } else {
        connectionStatus.textContent = 'Aguardando Autenticação';
        connectionStatus.className = 'status-badge warning';
        authSection.classList.remove('hidden');
        dashboardSection.classList.add('hidden');
      }
    } catch (error) {
      console.error('Error checking status:', error);
      connectionStatus.textContent = 'Erro de Conexão com Servidor';
      connectionStatus.className = 'status-badge error';
    }
  }

  async function loadDashboard() {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center">Carregando lista de contas...</td></tr>';
    mccInfo.textContent = 'Carregando contas da MCC...';

    try {
      // Fetch responsibles cache first
      await loadResponsiblesCache();

      const response = await fetch('/api/accounts');
      if (!response.ok) {
        throw new Error(await response.text());
      }
      
      const data = await response.json();
      const accounts = data.accounts || [];

      if (accounts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center">Nenhuma conta cliente ativa encontrada nesta MCC.</td></tr>';
        mccInfo.textContent = 'MCC sem contas ativas vinculadas.';
        return;
      }

      mccInfo.textContent = `MCC ativa. Total de contas ativas encontradas: ${accounts.length}`;
      tbody.innerHTML = ''; // Clear table

      // Render loading row for each account and fetch its budget info
      accounts.forEach(account => {
        const row = document.createElement('tr');
        row.id = `row-${account.id}`;
        row.innerHTML = `
          <td><strong>${formatAccountId(account.id)}</strong></td>
          <td>${escapeHtml(account.name)}</td>
          <td colspan="6" class="loading-cell text-center">
            <span class="spinner"></span> Carregando dados...
          </td>
        `;
        tbody.appendChild(row);

        // Fetch budget details asynchronously
        fetchBudgetDetails(account);
      });

    } catch (error) {
      console.error('Error loading dashboard:', error);
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="error-cell text-center">
            <strong>Erro ao carregar contas da MCC:</strong> ${escapeHtml(error.message)}
          </td>
        </tr>
      `;
      mccInfo.textContent = 'Falha ao sincronizar com a MCC.';
    }
  }

  async function fetchBudgetDetails(account) {
    const row = document.getElementById(`row-${account.id}`);
    if (!row) return;

    try {
      const response = await fetch(`/api/account-budget/${account.id}`);
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || `HTTP ${response.status}`);
      }

      const budget = await response.json();
      renderAccountRow(row, account, budget);
    } catch (error) {
      console.error(`Error loading budget for account ${account.id}:`, error);
      
      // Parse details if it's JSON from Google Ads API
      let errorMsg = 'Falha de conexão';
      try {
        const errorJson = JSON.parse(error.message);
        if (errorJson.details?.errors?.[0]?.message) {
          errorMsg = errorJson.details.errors[0].message;
        }
      } catch (e) {
        if (error.message.includes('USER_PERMISSION_DENIED')) {
          errorMsg = 'Permissão Negada (MCC sem acesso)';
        } else if (error.message.includes('DEVELOPER_TOKEN_NOT_APPROVED')) {
          errorMsg = 'Developer Token pendente aprovação';
        } else {
          errorMsg = error.message;
        }
      }

      row.innerHTML = `
        <td><strong>${formatAccountId(account.id)}</strong></td>
        <td>${escapeHtml(account.name)}</td>
        <td colspan="6" class="error-text text-center">
          ⚠️ ${escapeHtml(errorMsg)}
        </td>
      `;
    }
  }

  function renderAccountRow(row, account, budget) {
    const spentText = formatCurrency(budget.monthlySpent, account.currencyCode);
    const scheduledDailyBudgetText = formatCurrency(budget.scheduledDailyBudget, account.currencyCode);
    
    let remainingText = '-';
    let remainingClass = '';
    
    if (budget.remaining !== null) {
      remainingText = formatCurrency(budget.remaining, account.currencyCode);
      if (budget.remaining <= 0) {
        remainingClass = 'alert-danger';
      } else if (budget.remaining < 2000) {
        remainingClass = 'alert-warning';
      }
    } else if (budget.isInfinite) {
      remainingText = 'Ilimitado';
    }

    let pctText = '-';
    if (budget.limit !== null && budget.limit > 0 && budget.remaining !== null) {
      const pct = ((budget.remaining / budget.limit) * 100).toFixed(1);
      pctText = `${pct.replace('.', ',')}%`;
    } else if (budget.isInfinite) {
      pctText = '100%';
    }

    let daysLeftText = '-';
    if (budget.remaining !== null && budget.scheduledDailyBudget !== null && budget.scheduledDailyBudget > 0) {
      const days = budget.remaining / budget.scheduledDailyBudget;
      if (days < 0) {
        daysLeftText = '0 dias';
      } else {
        daysLeftText = `${Math.floor(days)} dias`;
      }
    } else if (budget.isInfinite) {
      daysLeftText = 'Ilimitado';
    }

    // Build notification column HTML
    const contacts = globalResponsiblesMap.get(account.id) || [];
    let notifyHtml = '<div class="notify-list">';
    if (contacts.length > 0) {
      contacts.forEach(c => {
        notifyHtml += `
          <div class="notify-contact-item">
            <span>${escapeHtml(c.nome)}</span>
            <button class="btn-notify-action btn-notify-trigger" 
              data-id-conta="${account.id}"
              data-nome-conta="${escapeHtml(account.name)}"
              data-id-responsavel="${c.id}"
              data-nome-responsavel="${escapeHtml(c.nome)}"
              data-email-responsavel="${escapeHtml(c.email || '')}"
              data-telefone-responsavel="${escapeHtml(c.telefone || '')}"
              data-saldo="${escapeHtml(remainingText)}"
              data-dias="${escapeHtml(daysLeftText)}"
              title="Notificar ${escapeHtml(c.nome)}">
              🔔
            </button>
          </div>
        `;
      });
    } else {
      notifyHtml += '<span class="text-muted" style="font-size: 11px;">Nenhum responsável</span>';
    }
    notifyHtml += '</div>';

    row.innerHTML = `
      <td><strong>${formatAccountId(account.id)}</strong></td>
      <td>${escapeHtml(account.name)}</td>
      <td>${spentText}</td>
      <td>${scheduledDailyBudgetText}</td>
      <td class="${remainingClass}"><strong>${remainingText}</strong></td>
      <td><strong>${pctText}</strong></td>
      <td><strong>${daysLeftText}</strong></td>
      <td>${notifyHtml}</td>
    `;

    // Bind notify triggers in this row
    row.querySelectorAll('.btn-notify-trigger').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const dataset = e.currentTarget.dataset;
        openNotifyModal(
          dataset.idConta,
          dataset.nomeConta,
          dataset.idResponsavel,
          dataset.nomeResponsavel,
          dataset.emailResponsavel,
          dataset.telefoneResponsavel,
          dataset.saldo,
          dataset.dias
        );
      });
    });
  }

  async function loadResponsibles() {
    responsiblesTbody.innerHTML = '<tr><td colspan="4" class="text-center">Carregando responsáveis...</td></tr>';
    try {
      const response = await fetch('/api/responsibles');
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const data = await response.json();
      const list = data.responsibles || [];

      if (list.length === 0) {
        responsiblesTbody.innerHTML = '<tr><td colspan="4" class="text-center">Nenhuma conta encontrada. Carregue a lista de contas na aba de orçamentos primeiro.</td></tr>';
        return;
      }

      responsiblesTbody.innerHTML = '';
      list.forEach(row => {
        const tr = document.createElement('tr');
        
        let contactsHtml = '';
        if (row.contacts && row.contacts.length > 0) {
          row.contacts.forEach(c => {
            contactsHtml += `
              <div class="contact-item">
                <div class="contact-info">
                  <strong>${escapeHtml(c.nome)}</strong>
                  <span class="contact-sub">
                    ${c.email ? escapeHtml(c.email) : '-'} | ${c.telefone ? escapeHtml(c.telefone) : '-'}
                  </span>
                </div>
                <div class="contact-actions">
                  <button class="btn-icon btn-edit-contact" 
                    data-id="${c.id}"
                    data-id-conta="${row.id_conta}"
                    data-nome-conta="${escapeHtml(row.nome_conta)}"
                    data-nome="${escapeHtml(c.nome)}"
                    data-email="${escapeHtml(c.email || '')}"
                    data-telefone="${escapeHtml(c.telefone || '')}">
                    ✏️
                  </button>
                  <button class="btn-icon btn-delete-contact" 
                    data-id="${c.id}"
                    data-nome="${escapeHtml(c.nome)}">
                    🗑️
                  </button>
                </div>
              </div>
            `;
          });
        } else {
          contactsHtml = '<span class="text-muted">Nenhum responsável cadastrado</span>';
        }

        tr.innerHTML = `
          <td><strong>${formatAccountId(row.id_conta)}</strong></td>
          <td>${escapeHtml(row.nome_conta)}</td>
          <td>${contactsHtml}</td>
          <td class="text-center">
            <button class="btn btn-secondary btn-sm btn-add-resp" 
              data-id-conta="${row.id_conta}" 
              data-nome-conta="${escapeHtml(row.nome_conta)}">
              + Adicionar
            </button>
          </td>
        `;
        responsiblesTbody.appendChild(tr);
      });

      // Bind Add buttons
      document.querySelectorAll('.btn-add-resp').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const dataset = e.currentTarget.dataset;
          openEditModal(dataset.idConta, dataset.nomeConta, '', '', '', null);
        });
      });

      // Bind Edit buttons
      document.querySelectorAll('.btn-edit-contact').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const dataset = e.currentTarget.dataset;
          openEditModal(
            dataset.idConta,
            dataset.nomeConta,
            dataset.nome,
            dataset.email,
            dataset.telefone,
            dataset.id
          );
        });
      });

      // Bind Delete buttons
      document.querySelectorAll('.btn-delete-contact').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const dataset = e.currentTarget.dataset;
          deleteContact(dataset.id, dataset.nome);
        });
      });

    } catch (error) {
      console.error('Error loading responsibles:', error);
      responsiblesTbody.innerHTML = `
        <tr>
          <td colspan="4" class="error-cell text-center">
            <strong>Erro ao carregar responsáveis:</strong> ${escapeHtml(error.message)}
          </td>
        </tr>
      `;
    }
  }

  async function deleteContact(id, nome) {
    if (!confirm(`Deseja realmente excluir o responsável "${nome}"?`)) {
      return;
    }

    try {
      const response = await fetch(`/api/responsibles/${id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      loadResponsibles();
    } catch (error) {
      console.error('Error deleting contact:', error);
      alert(`Erro ao excluir responsável: ${error.message}`);
    }
  }

  function openEditModal(idConta, nomeConta, nome, email, telefone, id) {
    modalIdConta.value = idConta;
    modalIdContaDisplay.textContent = formatAccountId(idConta);
    modalNomeContaDisplay.textContent = nomeConta;
    inputNome.value = nome || '';
    inputEmail.value = email || '';
    inputTelefone.value = telefone || '';
    modalIdResponsavel.value = id || '';

    editModal.classList.remove('hidden');
  }

  function closeEditModal() {
    editModal.classList.add('hidden');
    editForm.reset();
  }

  // Notify Modal Functions
  function openNotifyModal(idConta, nomeConta, idResponsavel, nomeResponsavel, email, telefone, saldo, dias) {
    notifyIdConta.value = idConta;
    notifyIdResponsavel.value = idResponsavel;
    
    let contactInfo = nomeResponsavel;
    if (email || telefone) {
      contactInfo += ` (${[email, telefone].filter(Boolean).join(' | ')})`;
    }
    notifyContactDisplay.textContent = contactInfo;

    // Default message template
    const templateMessage = `Olá, ${nomeResponsavel}!

Gostaríamos de informar que o saldo restante da conta Google Ads "${nomeConta}" (ID: ${formatAccountId(idConta)}) é de ${saldo}.

Com base no gasto diário programado, restam aproximadamente ${dias}.`;

    notifyMessage.value = templateMessage;
    notifySubject.value = `Aviso de Saldo - Google Ads: ${nomeConta}`;
    
    chkWhatsapp.checked = !!telefone;
    chkEmail.checked = !!email;
    groupSubject.style.display = email ? 'block' : 'none';

    notifyModal.classList.remove('hidden');
  }

  function closeNotifyModal() {
    notifyModal.classList.add('hidden');
    notifyForm.reset();
  }

  // Cache responsibles globally
  let globalResponsiblesMap = new Map();

  async function loadResponsiblesCache() {
    try {
      const response = await fetch('/api/responsibles');
      if (response.ok) {
        const data = await response.json();
        globalResponsiblesMap = new Map((data.responsibles || []).map(r => [r.id_conta, r.contacts || []]));
      }
    } catch (error) {
      console.error('Error loading responsibles cache:', error);
    }
  }

  // Helpers
  function formatAccountId(id) {
    if (!id) return '';
    const clean = id.toString().replace(/-/g, '');
    if (clean.length === 10) {
      return `${clean.slice(0, 3)}-${clean.slice(3, 6)}-${clean.slice(6)}`;
    }
    return id;
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      const cleanDate = dateStr.split(' ')[0];
      const [year, month, day] = cleanDate.split('-');
      return `${day}/${month}/${year}`;
    } catch (e) {
      return dateStr;
    }
  }

  function formatCurrency(val, currencyCode) {
    if (val === null || val === undefined || isNaN(val)) return 'N/A';
    try {
      return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: currencyCode || 'BRL'
      }).format(val);
    } catch (e) {
      return `${currencyCode || 'BRL'} ${val.toFixed(2)}`;
    }
  }

  function getCurrencySymbol(code) {
    if (code === 'BRL') return 'R$';
    if (code === 'USD') return '$';
    if (code === 'EUR') return '€';
    return code || '';
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
});
