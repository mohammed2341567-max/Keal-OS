/* KEAL Account and Friends Chat UI. Uses only the public Supabase client + RLS. */
(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const cloud = () => window.KealCloud;
  const setMsg = (el, text, bad=false) => { if(!el)return;el.textContent=text||'';el.classList.toggle('is-error',!!bad); };
  function lifecycle(root, cleanup) {
    const controller = new AbortController();
    const observer = new MutationObserver(() => {
      if (!root.isConnected) { controller.abort(); observer.disconnect(); try { cleanup?.(); } catch (_) {} }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return { signal: controller.signal, dispose: () => { controller.abort(); observer.disconnect(); try { cleanup?.(); } catch (_) {} } };
  }

  async function mountAccount(root) {
    if(!root)return;
    root.innerHTML = '<section class="ki-account"><div class="ki-head"><div><small>IDENTITY / PROFILE</small><h3>KEAL Account</h3></div><span class="ki-status" data-state>INITIALIZING</span></div><div class="ki-profile" data-profile></div><div class="ki-actions" data-actions></div><div class="ki-message" data-message role="status"></div><p class="ki-privacy">Your email is used by the sign-in provider and is not shown in KEAL Chat. Your public KEAL ID and nickname identify you to other members.</p></section>';
    const profile=root.querySelector('[data-profile]'), actions=root.querySelector('[data-actions]'), state=root.querySelector('[data-state]'), message=root.querySelector('[data-message]');
    const life=lifecycle(root);
    const render = async () => {
      await cloud().ready;
      const c=cloud(), p=c.profile, u=c.user;
      if(!c.configured){state.textContent='GUEST MODE';const g=c.guest();profile.innerHTML='<div class="ki-id-card"><span class="ki-avatar">K</span><div><small>THIS BROWSER ONLY</small><b>'+esc(g.nickname)+'</b><code>'+esc(g.keal_id)+'</code></div></div><p class="ki-muted">Cloud accounts and Friends Chat are not configured yet. Add your Supabase project URL and publishable key to <code>config.js</code>, then apply the SQL setup.</p>';actions.innerHTML='<button class="ki-button" data-refresh>REFRESH</button>';return;}
      if(!u){state.textContent='SIGNED OUT';profile.innerHTML='<div class="ki-id-card"><span class="ki-avatar">?</span><div><small>LOCAL GUEST ID</small><b>'+esc(c.guest().nickname)+'</b><code>'+esc(c.guest().keal_id)+'</code></div></div><p class="ki-muted">Sign in with Google to create your KEAL account. Only invited accounts are accepted after the database invite rule is configured.</p>';actions.innerHTML='<button class="ki-button ki-primary" data-google>CONTINUE WITH GOOGLE</button>';return;}
      if(!p){state.textContent='PROFILE UNAVAILABLE';profile.innerHTML='<p class="ki-muted">Your Google session is active, but the KEAL profile could not be loaded. Check the Supabase profile trigger and RLS setup, then refresh this window.</p>';actions.innerHTML='<button class="ki-button" data-refresh> RETRY </button><button class="ki-button ki-danger" data-signout> SIGN OUT </button>';return;}
      const id=p.keal_id, nick=p.nickname;
      state.textContent='ACCOUNT ACTIVE';
      profile.innerHTML='<div class="ki-id-card"><span class="ki-avatar">'+esc(nick.slice(0,1).toUpperCase())+'</span><div><small>YOUR PUBLIC ID</small><b>'+esc(nick)+'</b><code>'+esc(id)+'</code></div></div><label class="ki-label">CHANGE NICKNAME</label><div class="ki-input-row"><input maxlength="20" minlength="3" pattern="[A-Za-z0-9_-]{3,20}" data-nickname value="'+esc(nick)+'" autocomplete="nickname"><button class="ki-button" data-save> SAVE </button></div><small class="ki-muted">3–20 characters: letters, numbers, _ or -. Nicknames must be unique.</small>';
      actions.innerHTML='<button class="ki-button" data-copy> COPY KEAL ID </button><button class="ki-button ki-danger" data-signout> SIGN OUT </button>';
    };
    root.addEventListener('click',async e=>{
      const b=e.target.closest('button');if(!b)return;
      try{
        if(b.hasAttribute('data-google')){setMsg(message,'Opening Google sign-in…');await cloud().authSignIn();}
        else if(b.hasAttribute('data-signout')){await cloud().authSignOut();setMsg(message,'Signed out.');await render();}
        else if(b.hasAttribute('data-save')){const input=root.querySelector('[data-nickname]');const p=await cloud().updateNickname(input.value);setMsg(message,'Nickname updated to '+p.nickname+'.');await render();}
        else if(b.hasAttribute('data-copy')){await navigator.clipboard.writeText(cloud().profile?.keal_id||'');setMsg(message,'KEAL ID copied.');}
        else if(b.hasAttribute('data-refresh')){await render();}
      }catch(err){setMsg(message,err.message||'Action failed.',true);}
    }, {signal:life.signal});
    root.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches('[data-nickname]'))root.querySelector('[data-save]')?.click();}, {signal:life.signal});
    window.addEventListener('keal-identity',render,{signal:life.signal});
    await render();
  }

  async function mountChat(root) {
    if(!root)return;
    root.innerHTML='<section class="ki-chat"><div class="ki-head"><div><small>COMMUNITY / REALTIME</small><h3>Friends Chat</h3></div><span class="ki-status" data-chat-state>CONNECTING</span></div><div class="ki-chat-notice">Use your KEAL nickname. Avoid sharing addresses, passwords, school details, or other private information.</div><div class="ki-messages" data-messages aria-live="polite"><div class="ki-empty">Loading chat…</div></div><form class="ki-compose" data-form><textarea data-body maxlength="800" rows="2" placeholder="Write a message…" aria-label="Chat message"></textarea><button class="ki-button ki-primary" type="submit">SEND</button></form><div class="ki-message" data-message role="status"></div></section>';
    const status=root.querySelector('[data-chat-state]'), list=root.querySelector('[data-messages]'), form=root.querySelector('[data-form]'), input=root.querySelector('[data-body]'), message=root.querySelector('[data-message]');
    let stop=null, messages=[];
    const life=lifecycle(root,()=>{if(stop){stop();stop=null;}});
    const renderMessages=()=>{
      if(!messages.length){list.innerHTML='<div class="ki-empty">No messages yet. Start the conversation 👋</div>';return;}
      list.innerHTML=messages.map(m=>{const profile=Array.isArray(m.profile)?m.profile[0]:m.profile;const nick=profile?.nickname||'KEAL Member';const id=profile?.keal_id||'';const date=new Date(m.created_at).toLocaleString();return '<article class="ki-message-row"><div class="ki-message-meta"><b>'+esc(nick)+'</b><code>'+esc(id)+'</code><time>'+esc(date)+'</time></div><p>'+esc(m.body)+'</p></article>';}).join('');
      list.scrollTop=list.scrollHeight;
    };
    async function load(){
      await cloud().ready;const c=cloud();
      if(!c.configured){status.textContent='NOT CONFIGURED';list.innerHTML='<div class="ki-empty">Friends Chat needs a configured Supabase project. See <code>supabase/SETUP.md</code>.</div>';form.hidden=true;return;}
      if(!c.user){status.textContent='SIGN IN REQUIRED';list.innerHTML='<div class="ki-empty">Open KEAL Account and sign in with an invited Google account to join the lobby.</div>';form.hidden=true;return;}
      form.hidden=false;status.textContent='CONNECTING…';
      try{messages=await c.listMessages(70);renderMessages();status.textContent='LOBBY';setMsg(message,'Connected as '+(c.profile?.nickname||'KEAL member')+'.');}
      catch(err){status.textContent='CHAT ERROR';list.innerHTML='<div class="ki-empty">'+esc(err.message||'Could not load messages.')+'</div>';return;}
      if(stop)stop();stop=c.subscribeChat(async row=>{
        if(messages.some(m=>m.id===row.id))return;
        try{const fresh=await c.listMessages(70);messages=fresh;renderMessages();}catch(_){/* keep current view */}
      });
    }
    form.addEventListener('submit',async e=>{e.preventDefault();const text=input.value.trim();if(!text)return;const button=form.querySelector('button');button.disabled=true;try{await cloud().sendMessage(text);input.value='';setMsg(message,'Message sent.');}catch(err){setMsg(message,err.message||'Message not sent.',true);}finally{button.disabled=false;}});
    window.addEventListener('keal-identity',()=>{if(stop){stop();stop=null;}load();},{signal:life.signal});
    await load();
  }
  window.KealIdentity={mountAccount,mountChat};
})();
