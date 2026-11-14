'use strict';

const { XMLParser } = require('fast-xml-parser');
const DashToHlsService = require('../src/services/DashToHlsService');
const { parseXml, createMiniXmlParser } = require('../src/services/plooplayer/miniXml');

const isArray = (name) => DashToHlsService.ALWAYS_ARRAY_TAGS.has(name);
const fxp = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseAttributeValue: true, isArray });

// Shapes taken from the live Plooplayer feeds: Amazon-style SegmentTimeline and
// Akamai-style $Number$ templates, namespaced protection boxes, entities.
const TIMELINE_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<!-- generated -->
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" type="dynamic"
     availabilityStartTime="1970-01-01T00:00:00Z" timeShiftBufferDepth="PT1M" minimumUpdatePeriod="PT2S">
  <Period id="1" start="PT0S">
    <BaseURL>https://cdn.example.com/live/</BaseURL>
    <AdaptationSet mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="573117b5-98d2-4b76-b25e-348ecb1c7ebe"/>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"><cenc:pssh>AAAAY3Bzc2g=</cenc:pssh></ContentProtection>
      <SegmentTemplate timescale="90000" media="video_$RepresentationID$_$Time$.m4s?a=1&amp;b=2" initialization="video_$RepresentationID$_init.mp4" startNumber="0">
        <SegmentTimeline><S t="1731600000000" d="180000" r="3"/><S d="180000"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="v1080" bandwidth="6000000" codecs="avc1.640028" width="1920" height="1080" frameRate="25"/>
      <Representation id="v720" bandwidth="3000000" codecs="avc1.4d401f" width="1280" height="720" frameRate="30000/1001"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" lang="spa">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>
      <SegmentTemplate timescale="48000" media="audio_$Time$.m4s" initialization="audio_init.mp4">
        <SegmentTimeline><S t="0" d="96256"/><S d="95232" r="2"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2"><AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/></Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const NUMBER_MPD = `<MPD type="static" mediaPresentationDuration="PT30S">
  <Period><AdaptationSet contentType="video" mimeType="video/mp4">
    <Representation id="1" bandwidth="4000000" codecs="avc1.64001f" width="1280" height="720">
      <BaseURL serviceLocation="a">dash/</BaseURL>
      <SegmentTemplate media="seg-$Number%05d$.m4s" initialization="init-$RepresentationID$.mp4" startNumber="0" duration="2" timescale="1"/>
    </Representation>
  </AdaptationSet></Period>
</MPD>`;

describe('miniXml', () => {
  test.each([['SegmentTimeline', TIMELINE_MPD], ['$Number$', NUMBER_MPD]])(
    'matches fast-xml-parser on a %s manifest', (_, xml) => {
      expect(parseXml(xml, { isArray }).MPD).toEqual(fxp.parse(xml).MPD);
    });

  test.each([['SegmentTimeline', TIMELINE_MPD], ['$Number$', NUMBER_MPD]])(
    'DashToHlsService.parseMpd gives the same result with either parser (%s)', (_, xml) => {
      const url = 'https://cdn.example.com/live/manifest.mpd';
      const withFxp = new DashToHlsService({ fetcher: async () => null }).parseMpd(xml, url);
      const withMini = new DashToHlsService({ fetcher: async () => null, xmlParser: createMiniXmlParser({ isArray }) }).parseMpd(xml, url);
      expect(withMini).toEqual(withFxp);
      expect(withMini.videoReps.length).toBeGreaterThan(0);
    });

  test('decodes entities and keeps strings that are not numbers', () => {
    const doc = parseXml('<a x="1&amp;2" y="007" z="1e3" w="true" v="12345678901234567890">t &lt; u</a>');
    expect(doc.a).toEqual({ '@_x': '1&2', '@_y': 7, '@_z': 1000, '@_w': true, '@_v': '12345678901234567890', '#text': 't < u' });
  });

  test('rejects malformed documents instead of guessing', () => {
    expect(() => parseXml('<MPD><Period></MPD>')).toThrow(/unexpected/);
    expect(() => parseXml('<MPD><Period>')).toThrow(/unclosed/);
    expect(() => parseXml('<MPD a=1></MPD>')).toThrow(/malformed/);
  });
});
