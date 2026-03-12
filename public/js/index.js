document.addEventListener('DOMContentLoaded', () => {
  const hasSeenEntry = localStorage.getItem('fuelFairSeenEntry');

  if (!hasSeenEntry) {
    window.location.replace('/entry.html');
  }
});