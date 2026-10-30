/* Hosted update notice. It never reloads automatically. */
(() => {
  'use strict';
  function start(){
    if(!window.KealRelay?.isWeb)return;
    let banner=null;
    async function check(){
      try{
        const u=window.KealRelay.pageUrl('version.json')+'?v='+Date.now();
        const r=await fetch(u,{cache:'no-store'});if(!r.ok)return;
        const data=await r.json();const latest=String(data.version||'');
        const current=String(window.KEAL_CONFIG?.appVersion||'6.1.0');
        if(latest&&latest!==current){
          if(!banner){banner=document.createElement('aside');banner.className='keal-update-notch';banner.innerHTML='<span>KEAL UPDATE AVAILABLE</span><small data-version></small><button type="button">RELOAD</button>';document.body.appendChild(banner);banner.querySelector('button').addEventListener('click',()=>{if(confirm('Reload KEAL OS? Your Notes and Code Lab auto-save, but wait for any visible SAVING state to finish.'))location.reload();});}
          banner.querySelector('[data-version]').textContent='v'+latest;
        }
      }catch(_){/* updates are best-effort */}
    }
    check();setInterval(check,5*60*1000);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
