// Iconos Airsonic / qBittorrent / escuchado / Mix del servicio ya-lo-tengo
// (repeat-one, puerto 8780). Solo en la red local (http): en el despliegue
// público (https + CSP script-src 'self') no existe ese servicio.
(function () {
  if (location.protocol !== 'http:') return;
  var s = document.createElement('script');
  s.src = 'http://' + location.hostname + ':8780/owned-badges.js';
  document.head.appendChild(s);
})();
