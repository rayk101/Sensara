document.documentElement.classList.add('js');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const motionVideos = [...document.querySelectorAll('video[data-motion]')];
const motionToggle = document.querySelector('#motion-toggle');
let paused = reducedMotion.matches;
function syncMotion() {
  document.body.classList.toggle('motion-paused', paused);
  motionToggle.setAttribute('aria-pressed', String(paused));
  motionToggle.innerHTML = paused ? '<span>▶</span> Play motion' : '<span>Ⅱ</span> Pause motion';
  motionVideos.forEach(video => {
    if (paused || document.hidden) video.pause();
    else video.play().catch(() => {
      paused = true;
      syncMotion();
    });
  });
}
syncMotion();
motionToggle.addEventListener('click', () => { paused = !paused; syncMotion(); });
reducedMotion.addEventListener('change', event => { paused = event.matches; syncMotion(); });
document.addEventListener('visibilitychange', syncMotion);
const menu = document.querySelector('.menu-button');
const nav = document.querySelector('#navigation');
function closeMenu() { nav.classList.remove('open'); menu.setAttribute('aria-expanded', 'false'); menu.setAttribute('aria-label', 'Open navigation'); }
menu.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  menu.setAttribute('aria-expanded', String(open));
  menu.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
});
nav.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
const tabs = [...document.querySelectorAll('[data-tab]')];
function selectTab(tab, focus = false) {
  tabs.forEach(button => {
    const selected = button === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(button.getAttribute('aria-controls'));
    panel.hidden = !selected;
    if (!selected) panel.querySelectorAll('video').forEach(video => video.pause());
  });
  if (focus) tab.focus();
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); selectTab(tabs[next], true); }
  });
});
const demoVideo = document.querySelector('#demo-video');
const captions = {stable:'Room 118 / Daily movement',fall:'Room 204 / A possible fall',choking:'Lounge area / A sign of distress',wandering:'Room 312 / Moving out of view'};
document.querySelectorAll('[data-video]').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-video]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    demoVideo.pause();
    demoVideo.src = `/demo-videos/${button.dataset.video}-demo.mp4`;
    document.querySelector('#demo-caption').textContent = captions[button.dataset.video];
    demoVideo.load();
    demoVideo.play().catch(() => { /* Native controls remain available if playback is blocked. */ });
  });
});
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (entry.isIntersecting) { entry.target.classList.add('visible'); observer.unobserve(entry.target); }
  }), {threshold:.06});
  document.querySelectorAll('.reveal').forEach(section => observer.observe(section));
} else document.querySelectorAll('.reveal').forEach(section => section.classList.add('visible'));

// Short research stories with proportional graphics and a direct source
const personShape = '<circle cx="30" cy="15" r="11"/><path d="M20 32h20c8 0 13 6 13 14v33c0 7-9 7-9 0V51h-3v74c0 9-10 9-10 0V85h-2v40c0 9-10 9-10 0V51h-3v28c0 7-9 7-9 0V46c0-8 5-14 13-14Z"/>';
const person = highlighted => `<svg viewBox="0 0 60 135" aria-hidden="true" class="${highlighted ? 'highlight' : ''}">${personShape}</svg>`;
const researchStories = {
  falls: {
    number: '1 in 4',
    fact: 'US adults aged 65 and older report a fall each year',
    source: 'CDC / Annual estimate ↗',
    url: 'https://www.cdc.gov/falls/data-research/',
    label: 'One of four people highlighted to represent one in four older adults reporting a fall each year',
    graphic: Array.from({length:4}, (_, i) => person(i === 0)).join('')
  },
  wandering: {
    number: '6 in 10',
    fact: 'People living with dementia will wander at least once',
    source: 'Alzheimer’s Association / Wandering ↗',
    url: 'https://www.alz.org/help-support/caregiving/stages-behaviors/wandering',
    label: 'Six of ten people highlighted to represent six in ten people with dementia who will wander at least once',
    graphic: Array.from({length:10}, (_, i) => person(i < 6)).join('')
  },
  caregiving: {
    number: '59%',
    fact: 'Of dementia caregivers report high to very high emotional stress',
    source: 'Alzheimer’s Association / 2026 report ↗',
    url: 'https://www.alz.org/alzheimers-dementia/facts-figures',
    label: '59 percent of a ring filled to represent dementia caregivers reporting high to very high emotional stress',
    graphic: `<div class="caregiver-graphic">${person(true)}</div>`
  }
};
const researchTabs = [...document.querySelectorAll('[data-research]')];
function showResearch(button, focus = false) {
  const key = button.dataset.research;
  const story = researchStories[key];
  researchTabs.forEach(tab => {
    const active = tab === button;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  document.querySelector('#research-panel').setAttribute('aria-labelledby', button.id);
  document.querySelector('#research-number').textContent = story.number;
  document.querySelector('#research-fact').textContent = story.fact;
  const source = document.querySelector('#research-source');
  source.textContent = story.source;
  source.href = story.url;
  const graphic = document.querySelector('#people-graphic');
  graphic.className = key === 'wandering' ? 'people-graphic ten-people' : 'people-graphic';
  graphic.innerHTML = story.graphic;
  document.querySelector('#research-graphic').setAttribute('aria-label', story.label);
  if (focus) button.focus();
}
researchTabs.forEach((button, index) => {
  button.addEventListener('click', () => showResearch(button));
  button.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % researchTabs.length;
    if (event.key === 'ArrowLeft') next = (index + researchTabs.length - 1) % researchTabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = researchTabs.length - 1;
    if (next !== undefined) { event.preventDefault(); showResearch(researchTabs[next], true); }
  });
});
showResearch(researchTabs[0]);
const roomPreviews = [...document.querySelectorAll('.mini-feeds video')];
const previewPlay = document.querySelector('#preview-play');
function updatePreviewButton() {
  const playing = roomPreviews.some(video => !video.paused);
  previewPlay.setAttribute('aria-pressed', String(playing));
  previewPlay.innerHTML = playing ? 'Pause room previews <span aria-hidden="true">Ⅱ</span>' : 'Play room previews <span aria-hidden="true">▷</span>';
}
roomPreviews.forEach(video => ['play','pause','ended'].forEach(event => video.addEventListener(event, updatePreviewButton)));
previewPlay.addEventListener('click', () => {
  const playing = roomPreviews.some(video => !video.paused);
  roomPreviews.forEach(video => {
    if (playing) video.pause();
    else video.play().catch(updatePreviewButton);
  });
});
