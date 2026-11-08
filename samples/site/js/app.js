document.addEventListener('DOMContentLoaded', () => {
  const b = document.getElementById('more');
  const c = document.getElementById('counter');
  let n = 0;
  b.addEventListener('click', () => { n++; c.textContent = String(n); console.log('clicked', n); });
  document.body.dataset.app = 'ok';
  console.log('app.js loaded');
});
