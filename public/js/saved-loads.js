let currentPage = 1;
const limit = 8;

document.addEventListener('DOMContentLoaded', () => {
  loadSavedLoads(currentPage);
});

function formatMoney(value) {
  if (value == null) return '$--';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value));
}

function formatNumber(value) {
  const n = Number(value);
  if (value == null || Number.isNaN(n)) return '--';
  return new Intl.NumberFormat('en-US').format(n);
}

async function loadSavedLoads(page = 1) {
  try {
    const res = await fetch(`/api/loads?page=${page}&limit=${limit}`);
    if (res.status === 401) {
      window.location.href = `/auth.html?returnUrl=${encodeURIComponent('/saved-loads.html')}`;
      return;
    }
    const payload = await res.json();

    const loads = payload.data || [];
    const container = document.getElementById('loads-container');
    const pagination = document.getElementById('pagination');

    if (!loads.length) {
      container.innerHTML = '<p>No loads saved yet.</p>';
      pagination.innerHTML = '';
      return;
    }

    container.innerHTML = loads.map(load => `
      <div class="load-card ${load.decision}">
        <div class="load-header">
            <strong>
                ${load.origin || '—'} → ${load.destination || '—'}
            </strong>
            <span class="decision ${load.decision}">
                ${load.decision?.toUpperCase() || '—'}
            </span>
        </div>

        <div class="load-grid">
            <div>Miles: <strong>${formatNumber(load.miles)}</strong></div>
            <div>Rate: <strong>${formatMoney(load.rate)}</strong></div>
            <div>Fuel Cost: <strong>${formatMoney(load.fuel_cost)}</strong></div>
            <div>Profit: <strong>${formatMoney(load.net_profit)}</strong></div>
            <div>$/Mile: <strong>${formatMoney(load.net_per_mile)}</strong></div>
            <div>Avg Diesel: <strong>${formatMoney(load.avg_gas_price)}</strong></div>
        </div>

        <div class="load-date">
          ${new Date(load.created_at).toLocaleString()}
        </div>
      </div>
    `).join('');

    renderPagination(payload.page, payload.totalPages);

  } catch (err) {
    console.error('Failed to load saved loads:', err);
  }
}

function renderPagination(page, totalPages) {
  const pagination = document.getElementById('pagination');
  if (!pagination) return;

  let buttons = '';

  if (page > 1) {
    buttons += `<button onclick="changePage(${page - 1})">Previous</button>`;
  }

  buttons += `<span> Page ${page} of ${totalPages} </span>`;

  if (page < totalPages) {
    buttons += `<button onclick="changePage(${page + 1})">Next</button>`;
  }

  pagination.innerHTML = buttons;
}

function changePage(page) {
  currentPage = page;
  loadSavedLoads(page);
}