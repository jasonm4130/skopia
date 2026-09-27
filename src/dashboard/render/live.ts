/** Skopia — the live WebSocket client script for authed app pages. */

// ---------------------------------------------------------------------------
// Live WebSocket client script (inserted into auth'd app pages)
// ---------------------------------------------------------------------------

export function liveScript(siteId: string, nonce: string): string {
  return `<script nonce="${nonce}">
(function(){
  var siteId=${JSON.stringify(siteId)};
  function connect(){
    var proto=location.protocol==='https:'?'wss':'ws';
    var ws=new WebSocket(proto+'://'+location.host+'/live?site='+encodeURIComponent(siteId));
    // Drive liveness refresh from the client: eviction is lazy server-side
    // (site-live.ts currentSnapshot()), so absent new site-wide traffic a
    // connected dashboard would otherwise show a stale count forever once a
    // visitor leaves. A periodic ping costs no DO storage write.
    var pingTimer=setInterval(function(){
      if(ws.readyState===WebSocket.OPEN) ws.send('ping');
    },15000);
    ws.onmessage=function(e){
      try{
        var d=JSON.parse(e.data);
        var el=document.getElementById('live-count');
        if(el) el.textContent=d.visitors;
        var list=document.getElementById('live-pages-list');
        if(list&&Array.isArray(d.topPages)){
          list.textContent='';
          if(d.topPages.length===0){
            var empty=document.createElement('li');
            empty.style.cssText='color:#8b92a4;font-size:13px;';
            empty.textContent='No one online right now.';
            list.appendChild(empty);
          }
          d.topPages.forEach(function(p){
            var row=document.createElement('li');
            row.style.cssText='display:flex;align-items:center;gap:11px;';
            var label=document.createElement('span');
            label.style.cssText="flex:1;font-size:12.5px;color:#cfd4e0;font-family:'JetBrains Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
            label.textContent=p.label;
            var count=document.createElement('span');
            count.style.cssText='flex:none;font-size:12px;color:#9aa1b2;';
            count.textContent=p.visitors;
            row.appendChild(label);
            row.appendChild(count);
            list.appendChild(row);
          });
        }
      }catch(err){}
    };
    ws.onclose=function(){clearInterval(pingTimer);setTimeout(connect,3000);};
  }
  connect();
})();
</script>`;
}
