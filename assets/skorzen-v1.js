(function(){
 const KEY='skorzen_v1_saved';
 const read=()=>{try{return JSON.parse(localStorage.getItem(KEY)||'{"teams":[],"matches":[],"analyses":[]}')}catch(e){return {teams:[],matches:[],analyses:[]}}};
 const write=x=>localStorage.setItem(KEY,JSON.stringify(x));
 window.SKORZEN_STORE={
  all:read,
  add:function(type,item){const d=read();d[type]=d[type]||[];const key=item.slug||item.id||item.title;const i=d[type].findIndex(x=>(x.slug||x.id||x.title)===key);if(i>=0)d[type].splice(i,1);else d[type].unshift({...item,savedAt:new Date().toISOString()});write(d);return i<0},
  remove:function(type,key){const d=read();d[type]=(d[type]||[]).filter(x=>(x.slug||x.id||x.title)!==key);write(d)},
  esc:function(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'" :'&#39;'}[c]))}
 };
})();