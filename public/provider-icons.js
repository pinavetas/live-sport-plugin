/* Icons shared by the setup, live and status pages.
   window.SportIcon(nameOrLabel) returns an inline SVG string for a sport / catalog.
   window.ProviderIcon(idOrName, label) returns an HTML string for a small tile:
   a sport glyph when the provider name implies a sport, otherwise a two-letter monogram.
   Nothing is fetched from provider sites. */
(function () {
  function svg(inner) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  }
  var ICONS = {
    football: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8.5l3.2 2.3-1.2 3.7h-4l-1.2-3.7z"/><path d="M12 8.5V3.2M15.2 10.8l5-1.6M14 14.5l3 4.2M10 14.5l-3 4.2M8.8 10.8l-5-1.6"/>'),
    basketball: svg('<circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18M5.6 5.6c3.6 3.6 3.6 9.2 0 12.8M18.4 5.6c-3.6 3.6-3.6 9.2 0 12.8"/>'),
    afootball: svg('<path d="M4 20C4 11 11 4 20 4c0 9-7 16-16 16z"/><path d="M9 15l6-6M10.5 10.5l3 3"/>'),
    hockey: svg('<path d="M5 3l8 14h6"/><ellipse cx="9" cy="20" rx="4" ry="1.5"/>'),
    baseball: svg('<circle cx="12" cy="12" r="9"/><path d="M7 4.5c2 2.2 2 12.8 0 15M17 4.5c-2 2.2-2 12.8 0 15"/>'),
    motorsport: svg('<path d="M5 21V4"/><path d="M5 4h13l-2 4 2 4H5"/><path d="M9 4v8M13 4v8"/>'),
    tennis: svg('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6c3.4 3.4 3.4 9.4 0 12.8M18.4 5.6c-3.4 3.4-3.4 9.4 0 12.8"/>'),
    cricket: svg('<path d="M15 3l6 6-10.5 10.5a2 2 0 0 1-2.8 0l-3.2-3.2a2 2 0 0 1 0-2.8z"/><circle cx="5.5" cy="19.5" r="1.8"/>'),
    rugby: svg('<ellipse cx="12" cy="12" rx="9" ry="5.5" transform="rotate(-35 12 12)"/><path d="M9.5 14.5l5-5M11 11l2 2"/>'),
    mma: svg('<path d="M7 11V7a3 3 0 0 1 3-3h3a4 4 0 0 1 4 4v3a5 5 0 0 1-5 5H9a2 2 0 0 1-2-2z"/><path d="M8 20h6"/>'),
    golf: svg('<path d="M12 3v14"/><path d="M12 3l7 3-7 3"/><ellipse cx="12" cy="20" rx="6" ry="1.5"/>'),
    darts: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/><path d="M21 3l-8 8"/>'),
    college: svg('<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/>'),
    live: svg('<circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>'),
    tv: svg('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    star: svg('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>'),
    replay: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 8v4l3 2"/>'),
    calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
    trophy: svg('<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5v1a3 3 0 0 0 3 3M16 6h3v1a3 3 0 0 1-3 3M12 13v4M9 20h6"/>')
  };

  // Order matters: the first matching rule wins.
  var SPORT_RULES = [
    [/live now|^live$/, 'live'],
    [/24\/7|\btv\b|network|channel/, 'tv'],
    [/upcoming/, 'clock'],
    [/your teams|favou?rite/, 'star'],
    [/american|nfl|american_football/, 'afootball'],
    [/college|ncaa/, 'college'],
    [/foot|soccer|premier|champions|la liga|serie a|bundesliga/, 'football'],
    [/cricket/, 'cricket'],
    [/rugby/, 'rugby'],
    [/basket|nba/, 'basketball'],
    [/motor|racing|f1|formula/, 'motorsport'],
    [/tennis|atp|wta/, 'tennis'],
    [/baseball|mlb/, 'baseball'],
    [/hockey|nhl/, 'hockey'],
    [/mma|ufc|boxing|fight/, 'mma'],
    [/golf/, 'golf'],
    [/dart/, 'darts'],
    [/replay|older/, 'replay'],
    [/today|yesterday|week|recent/, 'calendar']
  ];
  window.SportIcon = function (label) {
    var c = String(label || '').toLowerCase();
    for (var i = 0; i < SPORT_RULES.length; i++) {
      if (SPORT_RULES[i][0].test(c)) return ICONS[SPORT_RULES[i][1]];
    }
    return ICONS.trophy;
  };

  var PROVIDER_RULES = [
    [/basketball/, 'basketball'],
    [/nfl|americanfootball/, 'afootball'],
    [/hockey|nhl/, 'hockey'],
    [/mlb|baseball/, 'baseball'],
    [/race|motor|f1|formula/, 'motorsport'],
    [/soccer|footy|football/, 'football'],
    [/replay/, 'replay'],
    [/livetv|cdnlive|tdt/, 'tv']
  ];
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function monogram(name) {
    var words = String(name || '').replace(/\([^)]*\)/g, '').replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (!words.length) return '?';
    var m = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2);
    return m.toUpperCase();
  }
  window.ProviderGlyph = function (idOrName, label) {
    var key = String(idOrName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    for (var i = 0; i < PROVIDER_RULES.length; i++) {
      if (PROVIDER_RULES[i][0].test(key)) return ICONS[PROVIDER_RULES[i][1]];
    }
    return '<span class="mono">' + esc(monogram(label || idOrName)) + '</span>';
  };
  window.ProviderIcon = function (idOrName, label) {
    return '<span class="prov-icon" aria-hidden="true">' + window.ProviderGlyph(idOrName, label) + '</span>';
  };
})();
