/**
 * ReverseGen 共享顶部导航 — 所有页面统一注入同一份导航，当前页自动高亮。
 *
 * 设计：
 *  - 链接以本脚本位置（gui/）为基准拼绝对 URL，子路径部署（APP_BASE_PATH）下同样可用
 *  - 插入到 nav.topbar 的 .spacer 之后（右侧排列），与历史布局一致
 *  - 各页面只需保留 <nav class="topbar"> 中的品牌与页内专属控件，不再手写链接
 */
(function(){
  var script=document.currentScript;
  if(!script)return;
  var ROOT=new URL('.',script.src);
  var ITEMS=[
    {path:'index.html',label:'主页',match:['/','/index.html']},
    {path:'challenge-expectation/index.html',label:'挑战期望',match:['/challenge-expectation','/challenge-expectation/','/challenge-expectation/index.html']},
    {path:'analysis.html',label:'Triple 分析',match:['/analysis.html']},
    {path:'batch-generate.html',label:'批量产关',match:['/batch-generate.html']},
    {path:'generation-strategies.html',label:'产出策略',match:['/generation-strategies.html']},
  ];
  function currentPath(){
    var p=window.location.pathname;
    if(p==='/')return'/';
    return p.replace(/\/+$/,'');
  }
  function isActive(item){
    var cur=currentPath();
    return item.match.indexOf(cur)>=0;
  }
  function mount(){
    var nav=document.querySelector('nav.topbar');
    if(!nav||document.getElementById('reversegenNavLinks'))return;
    var box=document.createElement('div');
    box.className='topnav-links';box.id='reversegenNavLinks';
    ITEMS.forEach(function(item){
      var a=document.createElement('a');
      a.href=new URL(item.path,ROOT).href;
      a.textContent=item.label;
      if(isActive(item))a.className='active';
      box.appendChild(a);
    });
    var spacer=nav.querySelector('.spacer');
    if(spacer)spacer.insertAdjacentElement('afterend',box);
    else nav.appendChild(box);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);
  else mount();
})();
