document.addEventListener('DOMContentLoaded', () => {

  document.getElementById('entry-check-load')?.addEventListener('click', () => {
    localStorage.setItem('fuelFairSeenEntry', 'true');
  });

  const toggle = document.getElementById('entryToggle');
  const content = document.getElementById('entryContent');

  toggle?.addEventListener('click', () => {
    content.classList.toggle('open');
  });

});