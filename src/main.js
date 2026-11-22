import './style.css';
import { App } from './app.js';

function boot() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) throw new Error('WebGL2 indisponible');
  } catch {
    document.body.innerHTML = '<main style="font:16px system-ui;max-width:560px;margin:12vh auto;padding:0 20px;color:#e6ebf2;background:#0f1318"><h1>WebGL 2 est requis</h1><p>Votre navigateur ou votre carte graphique ne permet pas d\'afficher la 3D. Essayez une version récente de Chrome, Edge ou Firefox, et vérifiez que l\'accélération matérielle est activée.</p></main>';
    return;
  }
  window.__app = new App(); // utile pour les essais dans la console
}
boot();
