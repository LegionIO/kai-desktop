function browserCredentialTargetScript(expectedOrigin: string, action: string): string {
  return `(() => {
    const expectedOrigin=${JSON.stringify(expectedOrigin)};
    if (location.origin !== expectedOrigin) throw new Error('The page changed before saved-password autofill could begin.');
    const visible=(field)=>{
      if (!field || !field.isConnected || field.disabled || field.readOnly) return false;
      const rect=field.getBoundingClientRect();
      const viewportWidth=Math.max(Number(globalThis.innerWidth)||0,Number(document.documentElement?.clientWidth)||0);
      const viewportHeight=Math.max(Number(globalThis.innerHeight)||0,Number(document.documentElement?.clientHeight)||0);
      if (
        rect.width<=0 || rect.height<=0 || viewportWidth<=0 || viewportHeight<=0 ||
        rect.right<=0 || rect.bottom<=0 || rect.left>=viewportWidth || rect.top>=viewportHeight
      ) return false;
      for (let current=field; current && current.nodeType===1; current=current.parentElement) {
        const style=getComputedStyle(current);
        const opacity=Number(style.opacity||1);
        if (
          style.display==='none' || style.visibility==='hidden' || style.visibility==='collapse' ||
          style.contentVisibility==='hidden' || !Number.isFinite(opacity) || opacity<=0 ||
          current.hidden || current.inert || current.getAttribute('aria-hidden')==='true'
        ) return false;
      }
      if (typeof document.elementFromPoint!=='function') return false;
      const left=Math.max(0,rect.left), right=Math.min(viewportWidth,rect.right);
      const top=Math.max(0,rect.top), bottom=Math.min(viewportHeight,rect.bottom);
      const insetX=Math.min(2,(right-left)/2), insetY=Math.min(2,(bottom-top)/2);
      const points=[
        [(left+right)/2,(top+bottom)/2],
        [left+insetX,top+insetY],
        [right-insetX,top+insetY],
        [left+insetX,bottom-insetY],
        [right-insetX,bottom-insetY],
      ];
      return points.some(([x,y])=>{
        const hit=document.elementFromPoint(x,y);
        return hit===field || field.contains(hit);
      });
    };
    const tokens=(field)=>String(field.autocomplete||'').toLowerCase().split(/\\s+/);
    const identity=(field)=>(String(field.name||'')+' '+String(field.id||'')).toLowerCase();
    const fields=Array.from(document.querySelectorAll('input[type="password"]')).filter(visible);
    const current=fields.filter((field)=>tokens(field).includes('current-password'));
    const signupOrReset=fields.some((field)=>
      tokens(field).includes('new-password') ||
      /(?:^|[_\\s-])(new|confirm|repeat|reset|change|signup|register)(?:$|[_\\s-])/.test(identity(field)) ||
      /(new.?password|password.?confirm|confirm.?password|repeat.?password)/.test(identity(field))
    );
    const generic=fields.filter((field)=>
      !tokens(field).includes('new-password') &&
      !/(?:^|[_\\s-])(new|confirm|repeat|reset|change|signup|register)(?:$|[_\\s-])/.test(identity(field)) &&
      !/(new.?password|password.?confirm|confirm.?password|repeat.?password)/.test(identity(field))
    );
    const candidates=current.length>0 ? current : (signupOrReset ? [] : generic);
    if (candidates.length!==1) throw new Error('Saved-password autofill requires one unambiguous visible login field.');
    const passwordField=candidates[0];
    const root=passwordField.form||document;
    const usernameCandidates=Array.from(root.querySelectorAll('input')).filter((field)=>
      visible(field) && ['text','email'].includes(String(field.type||'text').toLowerCase())
    );
    const explicitUsername=usernameCandidates.filter((field)=>tokens(field).includes('username'));
    if (explicitUsername.length>1) throw new Error('Saved-password autofill requires one unambiguous visible username field.');
    const semanticUsername=usernameCandidates.filter((field)=>
      String(field.type||'').toLowerCase()==='email' ||
      /(?:^|[_\\s-])(?:user|username|email|login)(?:$|[_\\s-])/.test(identity(field))
    );
    if (explicitUsername.length===0 && semanticUsername.length>1) {
      throw new Error('Saved-password autofill requires one unambiguous visible username field.');
    }
    let usernameField=explicitUsername[0]||semanticUsername[0]||null;
    if (!usernameField && usernameCandidates.length===1) {
      const only=usernameCandidates[0];
      if ((only.compareDocumentPosition(passwordField)&4)!==0) usernameField=only;
    }
    if (!usernameField && usernameCandidates.length>0) {
      throw new Error('Saved-password autofill requires one unambiguous visible username field.');
    }
    const set=(field,value)=>{
      if(!field)return true;
      try {
        const descriptor=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
        if(typeof descriptor?.set!=='function')return false;
        descriptor.set.call(field,value);
        field.dispatchEvent(new Event('input',{bubbles:true}));
        field.dispatchEvent(new Event('change',{bubbles:true}));
        return true;
      } catch {
        // A hostile page can replace the input setter and throw the plaintext
        // value it receives. Never let that exception cross back to main.
        return false;
      }
    };
    ${action}
  })()`;
}

/** Probe a same-origin frame for one unambiguous login target without placing
 * credential plaintext in that frame's JavaScript source. */
export function browserAutofillProbeScript(expectedOrigin: string): string {
  return browserCredentialTargetScript(expectedOrigin, 'return true;');
}

/** Build the isolated page script used for saved-password autofill. The script
 * fails closed unless it can identify exactly one visible, enabled login/current
 * password field. Signup/reset fields marked new-password are never targets. */
export function browserAutofillScript(username: string, password: string, expectedOrigin: string): string {
  return browserCredentialTargetScript(
    expectedOrigin,
    `const username=${JSON.stringify(username)}, password=${JSON.stringify(password)};
    if(!set(usernameField,username))return false;
    if(!set(passwordField,password))return false;
    try { passwordField.focus(); } catch { return false; }
    return true;`,
  );
}
