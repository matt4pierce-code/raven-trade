useEffect(()=>{
  if("Notification" in window && Notification.permission==="default"){
    Notification.requestPermission();
  }
},[]);

const pushNotify=useCallback((title,body)=>{
  if("Notification" in window && Notification.permission==="granted"){
    new Notification(title,{body,icon:"/favicon.ico",badge:"/favicon.ico",vibrate:[200,100,200]});
  }
},[]);
