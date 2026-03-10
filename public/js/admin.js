async function exportLoadsCsv() {
  const btn = document.getElementById('export-btn');
  const status = document.getElementById('admin-status');

  const from = document.getElementById('from-date')?.value || '';
  const to = document.getElementById('to-date')?.value || '';

  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);

  const url = `/api/admin/exports/loads.csv${qs.toString() ? `?${qs.toString()}` : ''}`;

  try {
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Preparing export...';

    const res = await fetch(url, { method: 'GET', credentials: 'include' });

    if (res.status === 401) {
      window.location.href = `/auth.html?returnUrl=${encodeURIComponent('/admin.html')}`;
      return;
    }

    if (res.status === 403) {
      if (status) status.textContent = 'Not authorized (admin only).';
      return;
    }

    if (!res.ok) {
        let msg = `Export failed (${res.status})`;
        try {
            const data = await res.json();
            if (data?.error) msg += `: ${data.error}`;
        } catch (_) {}
        if (status) status.textContent = msg;
        return;
    }

    const blob = await res.blob();
    const downloadUrl = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = 'fuel-fair-loads-export.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();

    URL.revokeObjectURL(downloadUrl);
    if (status) status.textContent = 'Export downloaded.';
  } catch (e) {
    if (status) status.textContent = 'Network error exporting.';
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('export-btn')?.addEventListener('click', exportLoadsCsv);
});
