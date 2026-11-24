// Phone setup page served by the board's own Wi-Fi ("PlugPilot-xxxxxx") at http://192.168.4.1
// Self-contained (no internet while the phone is on the board's Wi-Fi). Talks to /api/state,
// /api/scan, /api/connect and /api/forget in main.cpp.
#pragma once
#include <pgmspace.h>

static const char PORTAL_HTML[] PROGMEM = R"HTML(<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PlugPilot · ตั้งค่า Wi-Fi</title>
<style>
:root{--a:#2563d9;--navy:#0b2a6b;--bg:#f4f7fc;--card:#fff;--ink:#14213d;--mut:#5b6b85;--line:#dbe3f0}
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
header{background:var(--navy);color:#fff;padding:14px 16px}
header b{font-size:19px}header small{display:block;opacity:.8}
main{max-width:480px;margin:auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:14px}
h2{font-size:16px;margin:0 0 10px}
.net{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:#fff;margin-bottom:6px;font:inherit;color:inherit;text-align:left}
.net.sel{border-color:var(--a);box-shadow:0 0 0 2px #2563d933}
.sig{color:var(--mut);font-size:13px;white-space:nowrap}
label{display:block;font-size:14px;color:var(--mut);margin:10px 0 4px}
input{width:100%;padding:11px;border:1px solid var(--line);border-radius:10px;font:inherit;color:inherit;background:#fff}
.chk{display:flex;align-items:center;gap:8px}.chk input{width:auto}
.btn{display:block;width:100%;padding:12px;border:0;border-radius:10px;background:var(--a);color:#fff;font:inherit;font-weight:600;margin-top:12px}
.btn.ghost{background:#e8effc;color:var(--a)}
.btn:disabled{opacity:.5}
.msg{padding:10px 12px;border-radius:10px;margin-top:12px;font-size:14px}
.ok{background:#dcfce7;color:#14532d}.bad{background:#fee2e2;color:#7f1d1d}.wait{background:#e8effc;color:#1e3a8a}
.saved{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)}
.saved button{border:0;background:none;color:#dc2626;font:inherit;padding:4px 8px}
.muted{color:var(--mut);font-size:13px;margin:8px 0 0}
</style></head><body>
<header><b>PlugPilot</b><small id="dev">ตั้งค่า Wi-Fi ของบอร์ด</small></header>
<main>
<div class="card"><h2>1. เลือก Wi-Fi ของสถานที่นี้</h2>
<div id="nets"><p class="muted">กำลังค้นหา…</p></div>
<button class="btn ghost" id="rescan" type="button">ค้นหาใหม่</button>
<p class="muted">ใช้ได้เฉพาะ Wi-Fi 2.4 GHz · ไม่เห็นชื่อ (Wi-Fi ซ่อน)? พิมพ์ชื่อเองในข้อ 2</p></div>
<div class="card"><h2>2. ใส่รหัสผ่าน</h2>
<label for="ssid">ชื่อ Wi-Fi</label><input id="ssid" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="32">
<label for="pass">รหัสผ่าน (เว้นว่างถ้าไม่มีรหัส)</label><input id="pass" type="password" autocomplete="off" maxlength="63">
<label class="chk"><input type="checkbox" id="show"> แสดงรหัสผ่าน</label>
<button class="btn" id="go" type="button">บันทึกและเชื่อมต่อ</button>
<div id="out"></div></div>
<div class="card"><h2>Wi-Fi ที่บอร์ดจำไว้</h2><div id="saved"></div>
<p class="muted">จำได้สูงสุด 5 แห่ง บอร์ดจะต่อ Wi-Fi ที่รู้จักและสัญญาณแรงที่สุดให้เอง ย้ายสถานที่ก็ไม่ต้องตั้งใหม่</p></div>
</main>
<script>
var $=function(i){return document.getElementById(i)},S=null,timer=null;
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function bars(r){return r>-60?'▂▄▆█':r>-70?'▂▄▆':r>-80?'▂▄':'▂'}
function api(p,body){
  var o=body?{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body).toString()}:{cache:'no-store'};
  return fetch(p,o).then(function(r){return r.json().then(function(j){if(!r.ok)throw j;return j})});
}
function msg(cls,html){$('out').innerHTML=html?'<div class="msg '+cls+'">'+html+'</div>':''}
var WHY={auth_failed:'รหัสผ่านไม่ถูกต้อง',ssid_not_found:'หา Wi-Fi นี้ไม่เจอ — ต้องเป็น 2.4 GHz และอยู่ใกล้เราเตอร์',connect_failed:'เชื่อมต่อไม่สำเร็จ ลองใหม่อีกครั้ง หรือขยับบอร์ดให้ใกล้เราเตอร์'};
function render(s){
  S=s;
  $('dev').textContent='บอร์ด '+s.id+' · โปรแกรม v'+s.fw;
  var n=$('nets');n.innerHTML='';
  if(!s.nets.length)n.innerHTML='<p class="muted">'+(s.scanning?'กำลังค้นหา…':'ไม่พบ Wi-Fi — กด “ค้นหาใหม่”')+'</p>';
  s.nets.forEach(function(x){
    var b=document.createElement('button');b.type='button';
    b.className='net'+(x.s===$('ssid').value?' sel':'');
    b.innerHTML='<span>'+esc(x.s)+(s.saved.indexOf(x.s)>=0?' <span class="sig">· จำไว้แล้ว</span>':'')+(/5\s?g(hz)?\b/i.test(x.s)?' <span class="sig">(อาจเป็น 5 GHz — ใช้ไม่ได้)</span>':'')+'</span><span class="sig">'+bars(x.r)+(x.l?' 🔒':'')+'</span>';
    b.onclick=function(){$('ssid').value=x.s;$('pass').value='';render(S);$('pass').focus()};
    n.appendChild(b);
  });
  $('rescan').disabled=s.scanning;
  var v=$('saved');v.innerHTML=s.saved.length?'':'<p class="muted">ยังไม่มี</p>';
  s.saved.forEach(function(x){
    var d=document.createElement('div');d.className='saved';d.innerHTML='<span>'+esc(x)+'</span>';
    var b=document.createElement('button');b.type='button';b.textContent='ลบ';
    b.onclick=function(){if(confirm('ลบ “'+x+'” ออกจากบอร์ด?'))api('/api/forget',{ssid:x}).then(render)};
    d.appendChild(b);v.appendChild(d);
  });
  var t=s.test;
  $('go').disabled=t.st==='testing';
  if(t.st==='testing')msg('wait','กำลังเชื่อมต่อ “'+esc(t.ssid)+'” … (ไม่เกิน 20 วินาที)<br><span class="muted">ถ้ามือถือหลุดจาก Wi-Fi ของบอร์ดระหว่างนี้ ให้เชื่อมต่อกลับแล้วเปิดหน้านี้อีกครั้ง</span>');
  else if(t.st==='ok')msg('ok','✔ เชื่อมต่อ “'+esc(t.ssid)+'” สำเร็จ และบันทึกแล้ว<br>บอร์ดจะปิด Wi-Fi ตั้งค่านี้ในไม่กี่วินาที แล้วกลับไปทำงานตามปกติ — ปิดหน้านี้ได้เลย');
  else if(t.st==='failed')msg('bad','✘ '+(WHY[t.reason]||WHY.connect_failed)+'<br><span class="muted">ยังไม่ได้บันทึก “'+esc(t.ssid)+'” — แก้แล้วกดอีกครั้ง</span>');
  poll(s.scanning||t.st==='testing'||t.st==='ok');
}
function poll(on){
  if(on&&!timer)timer=setInterval(function(){api('/api/state').then(render).catch(function(){})},1200);
  if(!on&&timer){clearInterval(timer);timer=null}
}
$('show').onchange=function(){$('pass').type=this.checked?'text':'password'};
$('rescan').onclick=function(){api('/api/scan',{}).then(render).catch(function(){})};
$('go').onclick=function(){
  var s=$('ssid').value,p=$('pass').value;
  if(!s.trim())return msg('bad','เลือกหรือพิมพ์ชื่อ Wi-Fi ก่อน');
  if(p&&p.length<8)return msg('bad','รหัส Wi-Fi ต้องยาว 8 ตัวขึ้นไป (หรือเว้นว่างถ้าไม่มีรหัส)');
  api('/api/connect',{ssid:s,pass:p}).then(render).catch(function(e){msg('bad',e&&e.error==='busy'?'บอร์ดกำลังค้นหา Wi-Fi อยู่ รอสักครู่แล้วกดอีกครั้ง':'ส่งค่าไม่สำเร็จ ลองอีกครั้ง')});
};
api('/api/state').then(function(s){render(s);if(!s.nets.length&&!s.scanning)$('rescan').onclick()}).catch(function(){msg('bad','ติดต่อบอร์ดไม่ได้ — ตรวจว่ามือถือยังต่อ Wi-Fi ของบอร์ดอยู่')});
</script></body></html>)HTML";
