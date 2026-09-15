(function () {
  try {
    var saved = localStorage.getItem('soundproof:theme');
    var preference = saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
    var theme = preference === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.style.colorScheme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#081217' : '#f5f2ea');
  } catch (_) {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.dataset.themePreference = 'system';
  }
}());
