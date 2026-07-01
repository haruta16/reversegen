(function(){
  var STORAGE_KEY='reversegen-theme';
  var LEGACY_KEY='reversegen-strategy-theme';
  var themes={
    amber:{label:'琥珀暗色',description:'当前经典配色',background:'#0d0d0c',accent:'#d4a853'},
    graphite:{label:'石墨暗色',description:'Codex 风格，中性低饱和',background:'#202321',accent:'#77b98b'},
    light:{label:'浅色工作台',description:'经典编辑器浅色界面',background:'#ffffff',accent:'#2563eb'},
    midnight:{label:'午夜蓝',description:'冷色深色，高信息对比',background:'#101419',accent:'#72a7d8'}
  };
  function storedTheme(){try{return localStorage.getItem(STORAGE_KEY)||localStorage.getItem(LEGACY_KEY)||'amber'}catch(e){return'amber'}}
  function applyTheme(key,persist){if(!themes[key])key='amber';document.documentElement.dataset.theme=key;if(persist){try{localStorage.setItem(STORAGE_KEY,key)}catch(e){}}renderPicker()}
  function swatch(theme){return'<span class="rg-theme-swatch" style="--swatch-bg:'+theme.background+';--swatch-accent:'+theme.accent+'"></span>'}
  function pickerHtml(){return'<button type="button" class="rg-theme-trigger" id="globalThemeTrigger" aria-haspopup="menu" aria-expanded="false" title="切换界面主题">'+swatch(themes.amber)+'<span class="rg-theme-label" id="globalThemeLabel"></span><span class="rg-theme-caret">⌄</span></button><div class="rg-theme-menu" id="globalThemeMenu" role="menu" hidden>'+Object.keys(themes).map(function(key){var theme=themes[key];return'<button type="button" class="rg-theme-option" data-theme="'+key+'" aria-pressed="false">'+swatch(theme)+'<span class="rg-theme-copy"><strong>'+theme.label+'</strong><span>'+theme.description+'</span></span><span class="rg-theme-check"></span></button>'}).join('')+'</div>'}
  function closeMenu(){var menu=document.getElementById('globalThemeMenu'),trigger=document.getElementById('globalThemeTrigger');if(menu)menu.hidden=true;if(trigger)trigger.setAttribute('aria-expanded','false')}
  function renderPicker(){var key=document.documentElement.dataset.theme||'amber',theme=themes[key]||themes.amber,label=document.getElementById('globalThemeLabel'),trigger=document.getElementById('globalThemeTrigger');if(label)label.textContent=theme.label;if(trigger){var current=trigger.querySelector('.rg-theme-swatch');current.style.setProperty('--swatch-bg',theme.background);current.style.setProperty('--swatch-accent',theme.accent)}document.querySelectorAll('.rg-theme-option').forEach(function(option){var active=option.dataset.theme===key;option.setAttribute('aria-pressed',String(active));option.querySelector('.rg-theme-check').textContent=active?'✓':''})}
  function mountPicker(){var topbar=document.querySelector('.topbar');if(!topbar||document.getElementById('themePicker')||document.getElementById('globalThemePicker'))return;var picker=document.createElement('div');picker.className='rg-theme-picker';picker.id='globalThemePicker';picker.innerHTML=pickerHtml();var firstLink=topbar.querySelector('a');if(firstLink)topbar.insertBefore(picker,firstLink);else topbar.appendChild(picker);picker.querySelector('#globalThemeTrigger').addEventListener('click',function(event){event.stopPropagation();var menu=document.getElementById('globalThemeMenu'),open=menu.hidden;menu.hidden=!open;this.setAttribute('aria-expanded',String(open))});picker.querySelectorAll('.rg-theme-option').forEach(function(option){option.addEventListener('click',function(){applyTheme(option.dataset.theme,true);closeMenu()})});document.addEventListener('click',function(event){if(!picker.contains(event.target))closeMenu()});document.addEventListener('keydown',function(event){if(event.key==='Escape')closeMenu()});renderPicker()}
  applyTheme(storedTheme(),false);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mountPicker);else mountPicker();
  window.addEventListener('storage',function(event){if(event.key===STORAGE_KEY&&themes[event.newValue])applyTheme(event.newValue,false)});
})();
