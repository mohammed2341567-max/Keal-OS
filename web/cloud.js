/* KEAL Cloud adapter: optional Supabase Auth, per-user data, chat and Web relay.
 * No privileged key is accepted here. All access is enforced by Supabase RLS.
 */
(() => {
  'use strict';
  const cfg = window.KEAL_CONFIG || {};
  const state = {
    client: null, user: null, profile: null, ready: false, error: '',
    channel: null, channelStatus: 'offline', role: null, instance: null,
    focus: 'local', revision: 0, seq: 0, queue: [],
    heartbeats: { controller: null, client: null },
    settings: { wallpaper_master: 'midnight', wallpaper_client: 'midnight' },
    filesRev: 0, appsRev: 0, catalog: [],
    subs: new Set(),
  };
  const encoder = new TextEncoder();
  const guestKey = 'keal.guest.v1';
  const guestNickKey = 'keal.guest.nickname.v1';
  const randomId = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxxyxxx4xxxyxxxyxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c==='x'?r:(r&3|8)).toString(16); }));
  const randomGuest = () => {
    const a = ['Blue','Bright','Silent','Silver','Nova','Cosmic','Swift','Arctic','Golden','Neon'];
    const b = ['Falcon','Comet','Raven','Orbit','Panda','Phoenix','Otter','Voyager','Pixel','Tiger'];
    return a[Math.floor(Math.random()*a.length)] + b[Math.floor(Math.random()*b.length)] + (10 + Math.floor(Math.random()*90));
  };
  let guestId = localStorage.getItem(guestKey);
  if (!guestId) { guestId = randomId(); localStorage.setItem(guestKey, guestId); }
  if (!localStorage.getItem(guestNickKey)) localStorage.setItem(guestNickKey, randomGuest());
  const guest = () => ({ id: 'guest-' + guestId, keal_id: 'GUEST-' + guestId.replace(/-/g,'').slice(0,8).toUpperCase(), nickname: localStorage.getItem(guestNickKey) || 'Guest', is_guest: true });
  const result = (ok, status, data, extra={}) => ({ ok, status, data, ms: 0, ...extra });
  const parseUrl = path => new URL(path, location.href);
  const q = (path, key) => parseUrl(path).searchParams.get(key);
  const extOk = p => /\.(txt|md|py|js|html|css|json|xml|csv|yml|yaml|toml|sh|sql)$/i.test(p);
  const validPath = p => typeof p === 'string' && p.length > 0 && p.length <= 240 && !p.startsWith('/') && !p.includes('\\') && !p.includes('\0') && p.split('/').every(x => x && x !== '.' && x !== '..' && !x.startsWith('.') && /^[A-Za-z0-9 _.-]{1,80}$/.test(x));
  const filePrefix = 'keal.web.file.';
  const localSettingsKey = 'keal.web.settings.v1';
  const installedKey = 'keal.web.installed.v1';
  const asText = v => (typeof v === 'string' ? v : '');
  const fileVersion = async content => {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(content));
    return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,16);
  };
  function currentUid() { return state.user ? state.user.id : null; }
  function localFileKey(path) { return filePrefix + (currentUid() || guestId) + '.' + path; }
  function defaults() {
    return {
      'notes/quick-notes.md': '# Quick Notes\n\nWelcome to KEAL OS.\n',
      'code/main.py': '# KEAL Code Lab\nprint("Hello from KEAL")\n',
      'projects/README.md': '# Projects\n\nYour browser-based workspace.\n',
      'README.txt': 'KEAL OS Web Edition\nFiles here are private to this browser account.\n'
    };
  }
  function ensureLocalFiles() {
    const prefix = filePrefix + (currentUid() || guestId) + '.';
    if (Object.keys(localStorage).some(k=>k.startsWith(prefix))) return;
    Object.entries(defaults()).forEach(([p,content])=>localStorage.setItem(prefix+p, JSON.stringify({kind:'file',content,version:'1'})));
  }
  function getLocalSettings() {
    try { return { ...state.settings, ...JSON.parse(localStorage.getItem(localSettingsKey)||'{}') }; } catch (_) { return { ...state.settings }; }
  }
  function installedLocal() {
    try { const v=JSON.parse(localStorage.getItem(installedKey)||'{}'); return {master:Array.isArray(v.master)?v.master:[],client:Array.isArray(v.client)?v.client:[]}; } catch (_) { return {master:[],client:[]}; }
  }
  async function loadCatalog() {
    if (state.catalog.length) return state.catalog;
    try {
      const catalogUrl = window.KealRelay ? window.KealRelay.pageUrl('apps-catalog.json') : new URL('apps-catalog.json', new URL('./', location.href)).href;
      const res = await fetch(catalogUrl, {cache:'no-store'});
      if (res.ok) { const data=await res.json(); state.catalog=Array.isArray(data.catalog)?data.catalog:[]; }
    } catch (_) { /* local server provides /api/apps instead */ }
    return state.catalog;
  }
  async function refreshProfile() {
    if (!state.client || !state.user) { state.profile = null; notifyIdentity(); return null; }
    const { data, error } = await state.client.from('keal_profiles').select('user_id,keal_id,nickname,created_at').eq('user_id',state.user.id).maybeSingle();
    if (error) { state.error = error.message; state.profile = null; notifyIdentity(); return null; }
    state.profile = data;
    notifyIdentity();
    return data;
  }
  function notifyIdentity() { window.dispatchEvent(new CustomEvent('keal-identity', {detail:{user:state.user, profile:state.profile, guest:guest(), configured:!!state.client, error:state.error}})); }
  function updateHeartbeat(role, instance, visible, at=Date.now()) {
    if (!['controller','client'].includes(role)) return;
    const old=state.heartbeats[role];
    if (old && old.instance !== instance && state.focus === 'samsung') { state.focus='local'; state.revision++; state.queue.length=0; broadcast('keal-focus',{target:'local',revision:state.revision,reason:'reconnected'}); }
    state.heartbeats[role]={instance,visible:!!visible,at};
  }
  const online = role => !!state.heartbeats[role] && Date.now()-state.heartbeats[role].at < 7000;
  function statusData() {
    const c=state.heartbeats.controller, k=state.heartbeats.client;
    if (state.focus==='samsung' && (!online('controller') || !online('client'))) { state.focus='local'; state.revision++; state.queue.length=0; }
    return {
      version:(cfg.appVersion||'6.1.0')+'-web', boot_id:'cloud-'+(currentUid()||'guest'), server_time:Math.floor(Date.now()/1000), uptime_s:0,
      controller_online:online('controller'), client_online:online('client'),
      controller_age:c?Math.max(0,(Date.now()-c.at)/1000):null, client_age:k?Math.max(0,(Date.now()-k.at)/1000):null,
      client_poll_age:null, controller_visible:c?c.visible:null, client_visible:k?k.visible:null,
      input_target:state.focus, focus_revision:state.revision, focus_reason:'cloud-session', latest_seq:state.seq,
      accepted_events:state.seq, rejected_batches:0, last_event:null, last_pointer:null, last_error:state.error?{reason:state.error,age:0}:null,
      heartbeat_timeout:7, files_rev:state.filesRev, files_root:'KEAL Cloud Files', settings:getLocalSettings(), apps_rev:state.appsRev
    };
  }
  async function broadcast(event,payload) {
    if (!state.channel || state.channelStatus!=='SUBSCRIBED') return false;
    try { const r=await state.channel.send({type:'broadcast',event,payload}); return r==='ok'; } catch (_) { return false; }
  }
  async function connectChannel() {
    if (!state.client || !state.user) return;
    if (state.channel) { try { await state.client.removeChannel(state.channel); } catch (_) {} state.channel=null; }
    const topic='keal-session:'+state.user.id;
    state.channel=state.client.channel(topic,{config:{private:true,broadcast:{self:false,ack:true}}});
    state.channel
      .on('broadcast',{event:'keal-heartbeat'},({payload})=>{ if (payload && payload.user_id===state.user.id) updateHeartbeat(payload.role,payload.instance,payload.visible,Date.now()); })
      .on('broadcast',{event:'keal-focus'},({payload})=>{ if (!payload) return; state.focus=payload.target==='samsung'?'samsung':'local'; state.revision=Number(payload.revision)||state.revision; state.queue.length=0; })
      .on('broadcast',{event:'keal-input'},({payload})=>{ if (!payload || payload.revision!==state.revision || state.focus!=='samsung' || payload.user_id!==state.user.id) return; (payload.events||[]).forEach(ev=>{state.seq=Math.max(state.seq,Number(ev.seq)||0);state.queue.push(ev);}); })
      .subscribe(s=>{ state.channelStatus=s; window.dispatchEvent(new CustomEvent('keal-cloud-status',{detail:{status:s}})); });
  }
  async function ensureDefaultsCloud() {
    if (!state.client || !state.user) return;
    try {
      const {count,error}=await state.client.from('keal_user_files').select('path',{count:'exact',head:true}).eq('user_id',state.user.id);
      if (!error && count===0) {
        for (const [path,content] of Object.entries(defaults())) await state.client.rpc('keal_write_file',{p_path:path,p_content:content,p_base:null,p_force:false});
      }
    } catch (_) {}
  }
  async function init() {
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) { state.ready=true; notifyIdentity(); return; }
    try {
      const mod=await import('https://esm.sh/@supabase/supabase-js@2');
      state.client=mod.createClient(cfg.supabaseUrl,cfg.supabaseAnonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true},realtime:{params:{eventsPerSecond:30}}});
      const {data}=await state.client.auth.getSession();
      state.user=data.session?.user||null;
      if (state.user) { await refreshProfile(); await connectChannel(); await ensureDefaultsCloud(); }
      state.client.auth.onAuthStateChange((_event,session)=>{
        state.user=session?.user||null;
        setTimeout(async()=>{ if(state.user){await refreshProfile();await connectChannel();await ensureDefaultsCloud();} else {state.profile=null;if(state.channel){state.client.removeChannel(state.channel);state.channel=null;} } notifyIdentity(); },0);
      });
    } catch (err) { state.error='Supabase initialization failed: '+String(err?.message||err); }
    state.ready=true; notifyIdentity();
  }
  const ready=init();
  async function authSignIn() {
    await ready;
    if (!state.client) throw new Error('Cloud sign-in is not configured. Edit config.js first.');
    let topLocation=location;
    try { if (window.top && window.top.location.origin===location.origin) topLocation=window.top.location; } catch (_) {}
    const redirectTo=topLocation.origin+topLocation.pathname;
    const {data,error}=await state.client.auth.signInWithOAuth({provider:'google',options:{redirectTo,skipBrowserRedirect:true}});
    if(error) throw error;
    if(data?.url) topLocation.assign(data.url);
  }
  async function authSignOut() { if(state.client) { const {error}=await state.client.auth.signOut(); if(error) throw error; } }
  async function updateNickname(value) {
    const name=String(value||'').trim();
    if(!/^[A-Za-z0-9_-]{3,20}$/.test(name)) throw new Error('Use 3–20 letters, numbers, _ or -.');
    if(!state.client||!state.user) throw new Error('Sign in first.');
    const {data,error}=await state.client.from('keal_profiles').update({nickname:name}).eq('user_id',state.user.id).select('user_id,keal_id,nickname,created_at').single();
    if(error) throw new Error(error.code==='23505'?'That nickname is already taken.':error.message);
    state.profile=data; notifyIdentity(); return data;
  }
  async function listMessages(limit=70) {
    if(!state.client||!state.user) throw new Error('Sign in to use KEAL Chat.');
    const {data,error}=await state.client.from('keal_chat_messages').select('id,sender_id,body,created_at,profile:keal_profiles!keal_chat_messages_sender_id_fkey(nickname,keal_id)').order('created_at',{ascending:false}).limit(limit);
    if(error) throw error;
    return (data||[]).reverse();
  }
  async function sendMessage(body) {
    const text=String(body||'').trim();
    if(!text||text.length>800) throw new Error('Message must be between 1 and 800 characters.');
    if(!state.client||!state.user) throw new Error('Sign in to use KEAL Chat.');
    const now=Date.now(); const last=Number(sessionStorage.getItem('keal.chat.lastSend')||0);
    if(now-last<1200) throw new Error('Please wait a moment before sending another message.');
    sessionStorage.setItem('keal.chat.lastSend',String(now));
    const {data,error}=await state.client.from('keal_chat_messages').insert({sender_id:state.user.id,body:text}).select('id,sender_id,body,created_at,profile:keal_profiles!keal_chat_messages_sender_id_fkey(nickname,keal_id)').single();
    if(error) throw error;
    return data;
  }
  function subscribeChat(callback) {
    if(!state.client||!state.user) return ()=>{};
    const ch=state.client.channel('keal-chat-lobby',{config:{private:true}})
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'keal_chat_messages'},payload=>callback(payload.new))
      .subscribe();
    return ()=>{try{state.client.removeChannel(ch);}catch(_){}};
  }

  // Browser-mode implementation of the existing /api/* contract.
  async function api(path, opts={}) {
    await ready;
    const method=(opts.method||'GET').toUpperCase(), body=opts.body||{};
    const u=parseUrl(path), route=u.pathname;
    const uid=currentUid();
    const fail=(status,error,more={})=>result(false,status,{ok:false,error,...more});
    try {
      if(route==='/api/status') return result(true,200,{ok:true,...statusData()});
      if(route==='/api/heartbeat' && method==='POST') {
        if(!uid) return fail(401,'sign_in_required');
        if(!state.channel || state.channelStatus!=='SUBSCRIBED') return fail(503,'realtime_not_ready');
        const role=body.role, instance=String(body.instance||'');
        if(!['controller','client'].includes(role)||!instance) return fail(400,'bad_heartbeat');
        updateHeartbeat(role,instance,body.visible);
        const sent=await broadcast('keal-heartbeat',{user_id:uid,role,instance,visible:!!body.visible,at:Date.now()});
        if(!sent) { state.heartbeats[role]=null; return fail(503,'heartbeat_broadcast_failed',statusData()); }
        return result(true,200,{ok:true,...statusData()});
      }
      if(route==='/api/focus' && method==='POST') {
        if(!uid) return fail(401,'sign_in_required');
        if(!state.channel || state.channelStatus!=='SUBSCRIBED') return fail(503,'realtime_not_ready');
        const target=body.target==='samsung'?'samsung':body.target==='local'?'local':null;
        if(!target) return fail(400,'bad_target');
        if(target==='samsung' && (!online('controller')||!online('client'))) return fail(409,'client_or_controller_offline',statusData());
        if(state.focus!==target){state.focus=target;state.revision++;state.queue.length=0;}
        const sent=await broadcast('keal-focus',{target,revision:state.revision,reason:'manual'});
        if(!sent) return fail(503,'focus_broadcast_failed',statusData());
        return result(true,200,{ok:true,...statusData()});
      }
      if(route==='/api/events' && method==='POST') {
        if(!uid) return fail(401,'sign_in_required');
        if(!state.channel || state.channelStatus!=='SUBSCRIBED') return fail(503,'realtime_not_ready');
        if(state.focus!=='samsung'||!online('controller')||!online('client')||Number(body.focus_revision)!==state.revision) return fail(409,'focus_or_connection_changed',statusData());
        if(!Array.isArray(body.events)||body.events.length>100) return fail(400,'bad_events');
        const clean=[];
        for(const item of body.events){
          if(!item||typeof item!=='object') continue;
          const ev={...item};
          if(!['pointermove','pointerdown','pointerup','mousedown','mouseup','click','dblclick','wheel','keydown','keyup'].includes(ev.type)) continue;
          if(['pointermove','pointerdown','pointerup','mousedown','mouseup','click','dblclick','wheel'].includes(ev.type)){if(!Number.isFinite(ev.x)||!Number.isFinite(ev.y))continue;ev.x=Math.max(0,Math.min(1280,ev.x));ev.y=Math.max(0,Math.min(720,ev.y));}
          if(ev.key!==undefined) ev.key=String(ev.key).slice(0,32);
          clean.push(ev);
        }
        if(clean.length){const seqBase=state.seq;const events=clean.map((ev,i)=>({...ev,seq:seqBase+i+1}));const sent=await broadcast('keal-input',{user_id:uid,revision:state.revision,events});if(!sent)return fail(503,'input_broadcast_failed',statusData());state.seq+=events.length;}
        return result(true,200,{ok:true,accepted:clean.length,invalid:body.events.length-clean.length,duplicate:0,...statusData()});
      }
      if(route==='/api/events' && method==='GET') {
        const since=Number(u.searchParams.get('since')||0), rev=Number(u.searchParams.get('rev')||state.revision), wait=Math.min(20,Math.max(0,Number(u.searchParams.get('wait')||0)))*1000;
        const started=Date.now();
        while(Date.now()-started<wait && !state.queue.some(e=>Number(e.seq)>since) && rev===state.revision && state.focus==='samsung') await new Promise(r=>setTimeout(r,100));
        const reset=rev!==state.revision||state.focus!=='samsung';
        const events=reset?[]:state.queue.filter(e=>Number(e.seq)>since).slice(0,200);
        if(events.length) state.queue=state.queue.filter(e=>Number(e.seq)>events[events.length-1].seq);
        return result(true,200,{ok:true,events,reset,...statusData()});
      }
      if(route==='/api/fs/list' && method==='GET') return await filesList(u.searchParams.get('path')||'');
      if(route==='/api/fs/read' && method==='GET') return await filesRead(u.searchParams.get('path')||'');
      if(route==='/api/fs/write' && method==='POST') return await filesWrite(body);
      if(route==='/api/fs/mkdir' && method==='POST') return await filesMkdir(body.path);
      if(route==='/api/fs/delete' && method==='POST') return await filesDelete(body.path);
      if(route==='/api/settings' && method==='GET') return result(true,200,{ok:true,settings:await settingsGet()});
      if(route==='/api/settings' && method==='POST') {const s=await settingsSet(body.key,body.value);return result(true,200,{ok:true,settings:s});}
      if(route==='/api/apps' && method==='GET') return result(true,200,{ok:true,...await appsSnapshot()});
      if((route==='/api/apps/install'||route==='/api/apps/uninstall')&&method==='POST') return await appChange(body.device,body.id,route.endsWith('/install'));
      if(route==='/api/media/list') return result(true,200,{ok:true,root:'Choose audio files in the browser Music app',tracks:[],media_token:''});
      return fail(404,'not_found');
    } catch(err) { return fail(500,String(err?.message||err).slice(0,180)); }
  }
  async function dbFiles() {
    if(state.client&&state.user){const {data,error}=await state.client.from('keal_user_files').select('path,kind,content,version').eq('user_id',state.user.id).limit(1000);if(error)throw error;return data||[];}
    ensureLocalFiles(); const prefix=filePrefix+(currentUid()||guestId)+'.'; const out=[];
    Object.keys(localStorage).filter(k=>k.startsWith(prefix)).forEach(k=>{try{const v=JSON.parse(localStorage.getItem(k));out.push({path:k.slice(prefix.length),kind:v.kind||'file',content:v.content||'',version:v.version||'1'});}catch(_){}});return out;
  }
  async function filesList(path) {
    if(path&&!validPath(path)) return result(false,400,{ok:false,error:'bad_path'});
    const rows=await dbFiles(), prefix=path?path+'/':''; const children=new Map();
    rows.forEach(row=>{if(!row.path.startsWith(prefix))return;const rest=row.path.slice(prefix.length);if(!rest)return;const parts=rest.split('/');if(parts.length>1)children.set(parts[0],{name:parts[0],type:'dir'});else children.set(parts[0],{name:parts[0],type:row.kind==='dir'?'dir':'file',size:(row.content||'').length});});
    const entries=[...children.values()].sort((a,b)=>(a.type!=='dir')-(b.type!=='dir')||a.name.localeCompare(b.name));
    return result(true,200,{ok:true,path,entries,root:state.client&&state.user?'KEAL Cloud Files':'Browser Local Files'});
  }
  async function filesRead(path) {
    if(!validPath(path)||!extOk(path)) return result(false,400,{ok:false,error:'bad_path_or_extension'});
    if(state.client&&state.user){const {data,error}=await state.client.from('keal_user_files').select('content,version,kind').eq('user_id',state.user.id).eq('path',path).maybeSingle();if(error)throw error;if(!data||data.kind!=='file')return result(false,404,{ok:false,error:'not_found'});return result(true,200,{ok:true,path,content:data.content||'',version:data.version});}
    const raw=localStorage.getItem(localFileKey(path));if(!raw)return result(false,404,{ok:false,error:'not_found'});const row=JSON.parse(raw);if(row.kind!=='file')return result(false,404,{ok:false,error:'not_found'});return result(true,200,{ok:true,path,content:row.content||'',version:row.version||'1'});
  }
  async function filesWrite(body) {
    const path=body.path, content=asText(body.content);
    if(!validPath(path)||!extOk(path)||encoder.encode(content).length>262144)return result(false,400,{ok:false,error:'bad_path_or_content'});
    if(state.client&&state.user){const {data,error}=await state.client.rpc('keal_write_file',{p_path:path,p_content:content,p_base:body.base||null,p_force:body.force===true});if(error)throw error;if(!data?.ok)return result(false,409,{ok:false,error:'conflict',current:data?.current||null});state.filesRev++;return result(true,200,{ok:true,path,version:data.version});}
    const key=localFileKey(path),raw=localStorage.getItem(key),current=raw?JSON.parse(raw):null;
    if(body.force!==true && (current?current.version:null)!==(body.base||null))return result(false,409,{ok:false,error:'conflict',current:current?{content:current.content,version:current.version}:null});
    const version=String((Number(current?.version)||0)+1);localStorage.setItem(key,JSON.stringify({kind:'file',content,version}));state.filesRev++;
    return result(true,200,{ok:true,path,version});
  }
  async function filesMkdir(path) {
    if(!validPath(path))return result(false,400,{ok:false,error:'bad_path'});
    if(state.client&&state.user){const {data,error}=await state.client.rpc('keal_mkdir',{p_path:path});if(error)throw error;if(!data?.ok)throw new Error('Could not create folder');}
    else localStorage.setItem(localFileKey(path),JSON.stringify({kind:'dir',content:'',version:'1'}));
    state.filesRev++;return result(true,200,{ok:true,path});
  }
  async function filesDelete(path) {
    if(!validPath(path))return result(false,400,{ok:false,error:'bad_path'});
    const rows=await dbFiles(), row=rows.find(x=>x.path===path);if(!row)return result(false,404,{ok:false,error:'not_found'});
    if(row.kind==='dir'&&rows.some(x=>x.path.startsWith(path+'/')))return result(false,409,{ok:false,error:'folder_not_empty'});
    if(state.client&&state.user){const {error}=await state.client.from('keal_user_files').delete().eq('user_id',state.user.id).eq('path',path);if(error)throw error;}
    else localStorage.removeItem(localFileKey(path));
    state.filesRev++;return result(true,200,{ok:true,path});
  }
  async function settingsGet(){
    if(state.client&&state.user){const {data,error}=await state.client.from('keal_user_settings').select('settings').eq('user_id',state.user.id).maybeSingle();if(error)throw error;return {...state.settings,...(data?.settings||{})};}
    return getLocalSettings();
  }
  async function settingsSet(key,value){
    const allowed={wallpaper_master:['midnight','aurora','ember','ocean','nebula','graphite'],wallpaper_client:['midnight','aurora','ember','ocean','nebula','graphite']};
    if(!allowed[key]||!allowed[key].includes(value))throw new Error('bad_setting');
    if(state.client&&state.user){const current=await settingsGet();current[key]=value;const {error}=await state.client.from('keal_user_settings').upsert({user_id:state.user.id,settings:current,updated_at:new Date().toISOString()},{onConflict:'user_id'});if(error)throw error;return current;}
    const current=getLocalSettings();current[key]=value;localStorage.setItem(localSettingsKey,JSON.stringify(current));return current;
  }
  async function appsSnapshot(){
    await loadCatalog(); let installed=installedLocal();
    if(state.client&&state.user){const {data,error}=await state.client.from('keal_installed_apps').select('device,app_id').eq('user_id',state.user.id);if(error)throw error;installed={master:[],client:[]};(data||[]).forEach(x=>{if(installed[x.device])installed[x.device].push(x.app_id);});}
    return {catalog:state.catalog,installed,problems:[]};
  }
  async function appChange(device,id,install){
    const snap=await appsSnapshot(), app=snap.catalog.find(x=>x.id===id);
    if(!['master','client'].includes(device)||!app||!app.targets.includes(device))return result(false,400,{ok:false,error:'invalid_app_or_device'});
    if(state.client&&state.user){
      if(install){const {error}=await state.client.from('keal_installed_apps').upsert({user_id:state.user.id,device,app_id:id},{onConflict:'user_id,device,app_id'});if(error)throw error;}
      else {const {error}=await state.client.from('keal_installed_apps').delete().eq('user_id',state.user.id).eq('device',device).eq('app_id',id);if(error)throw error;}
    } else {const arr=snap.installed[device];const next=install?[...new Set([...arr,id])]:arr.filter(x=>x!==id);const all=installedLocal();all[device]=next;localStorage.setItem(installedKey,JSON.stringify(all));}
    state.appsRev++;return result(true,200,{ok:true,...await appsSnapshot()});
  }

  window.KealCloud = {
    ready, state, guest, authSignIn, authSignOut, refreshProfile, updateNickname,
    listMessages, sendMessage, subscribeChat, api,
    get configured(){return !!state.client;}, get user(){return state.user;}, get profile(){return state.profile;},
  };
})();
