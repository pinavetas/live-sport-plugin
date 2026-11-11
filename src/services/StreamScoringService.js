class StreamScoringService {
  constructor() {}

  /**
   * Calculates a score out of 100 for a stream to determine sorting order.
   * Higher score = better UX for the user.
   */
  calculateScore(streamEntity, sourceName) {
    let score = 50; // Base score

    // 1. Native HLS vs Web Player (External)
    if (streamEntity.url) {
      score += 30; // Direct streaming is always preferred
    } else if (streamEntity.externalUrl) {
      score -= 20; // Having to open a web browser is a worse UX
    }

    // 2. Resolution
    const title = streamEntity.title || streamEntity.name || '';
    const res = String(streamEntity.resolution || streamEntity.quality || '').toLowerCase();
    if (title.includes('1080p') || res.includes('1080')) {
      score += 20;
    } else if (title.includes('720p') || res.includes('720')) {
      score += 10;
    } else if (title.includes('540p') || title.includes('SD') || res.includes('540') || res === 'sd') {
      score -= 5;
    }

    // 3. Direct CDN & Source Priority
    const isDirectPpvst = sourceName === 'ppvst' || streamEntity._source === 'ppvst';
    const isAk47 = sourceName === 'ak47live' || streamEntity._source === 'ak47live';
    const isTikTok = !isDirectPpvst && Boolean(
      streamEntity.isTikTok ||
      streamEntity._isTikTok ||
      (typeof streamEntity.url === 'string' && /tiktokcdn|byteoversea|ibytedtos|\.image/i.test(streamEntity.url))
    );

    if (isTikTok) {
      score -= 30; // Deprioritize worker-heavy streams
    } else {
      if (isAk47) {
        score += 25; // Highly responsive DASH/HLS
      } else if (isDirectPpvst) {
        score += 20; // Fast direct 1080p stream
      } else if (sourceName === 'vavoo' || streamEntity._source === 'vavoo') {
        score += 15;
      } else if (sourceName === 'sktech' || streamEntity._source === 'sktech') {
        score += 10;
      } else if (sourceName === 'daddylive' || streamEntity._source === 'daddylive') {
        score += 5; // Moderate bonus due to frequent ISP blocks on cdn.wideiptv
      } else {
        const otherDirect = ['golf', 'damitv'];
        if (otherDirect.includes(sourceName) || (streamEntity._source && otherDirect.includes(streamEntity._source))) {
          score += 10;
        }
      }
    }

    // 4. Source Reliability
    const reliableSources = ['ak47live', 'ppvst', 'golf', 'echo', 'delta', 'vavoo'];
    if (!isTikTok && reliableSources.includes(sourceName || streamEntity._source)) {
      score += 15;
    } else if (sourceName === 'daddylive' || streamEntity._source === 'daddylive') {
      score += 5;
    } else if (sourceName === 'timstreams') {
      score += 5;
    }

    return score;
  }
}

module.exports = StreamScoringService;
