// GA4 누적 사용자 수를 불러오는 Vercel 서버리스 함수 (외부 패키지 없음)
// 필요한 Vercel 환경변수:
//   GA_CLIENT_EMAIL   서비스 계정 이메일
//   GA_PRIVATE_KEY    서비스 계정 JSON의 private_key 값 그대로
//   GA_SAJU_PROPERTY  찐망고 사주 GA4 속성 ID (숫자)
//   GA_REF_PROPERTY   찐망고 레퍼런스 GA4 속성 ID (숫자)

const crypto = require('crypto');

const START_DATE = '2026-01-01';

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken() {
  const email = process.env.GA_CLIENT_EMAIL;
  const key = (process.env.GA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(key);
  const jwt = `${header}.${claim}.${b64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  return (await res.json()).access_token;
}

async function report(token, propertyId) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: START_DATE, endDate: 'today' }],
      metrics: [{ name: 'totalUsers' }, { name: 'activeUsers' }, { name: 'userEngagementDuration' }],
    }),
  });
  if (!res.ok) throw new Error(`report ${propertyId} ${res.status}`);
  const data = await res.json();
  const v = (data.rows?.[0]?.metricValues || []).map((m) => Number(m.value || 0));
  const [users = 0, active = 0, engagement = 0] = v;
  // GA4 화면의 '평균 참여 시간(활성 사용자당)'과 같은 계산 (초)
  return { users, avgEngagement: active ? Math.round(engagement / active) : 0 };
}

// 신규 vs 재방문 사용자 (GA4 newVsReturning 차원) — 실패하면 null
async function returning(token, propertyId) {
  try {
    const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate: START_DATE, endDate: 'today' }],
        dimensions: [{ name: 'newVsReturning' }],
        metrics: [{ name: 'activeUsers' }],
      }),
    });
    if (!res.ok) return null;
    const out = {};
    for (const r of (await res.json()).rows || []) out[r.dimensionValues[0].value || 'unknown'] = Number(r.metricValues[0].value);
    return { new: out.new || 0, returning: out.returning || 0 };
  } catch {
    return null;
  }
}

// 티스토리 블로그 사이드바의 "Total 396,850" 카운터를 읽어옴 (실패하면 null)
async function blogTotal() {
  try {
    const res = await fetch('https://uiweb.tistory.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; jjinmango-hub/1.0)' },
    });
    if (!res.ok) return null;
    const text = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const m = text.match(/Total\s*:?\s*([\d,]{4,})/i);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  } catch {
    return null;
  }
}

// 찐망고 레퍼런스 공개 숫자 (수집 사이트, 섹션) — 실패하면 null
async function refCounts() {
  try {
    const res = await fetch('https://ref.jjinmango.kr/api/stats');
    if (!res.ok) return null;
    const d = await res.json();
    return typeof d.sites === 'number' ? d : null;
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  try {
    const token = await getAccessToken();
    const [s, r, blog, rc, sRet, rRet] = await Promise.all([
      report(token, process.env.GA_SAJU_PROPERTY),
      report(token, process.env.GA_REF_PROPERTY),
      blogTotal(),
      refCounts(),
      returning(token, process.env.GA_SAJU_PROPERTY),
      returning(token, process.env.GA_REF_PROPERTY),
    ]);
    // Vercel 엣지 캐시: 6시간 동안 같은 값, 이후 하루까지는 옛 값 보여주면서 뒤에서 갱신
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    res.status(200).json({
      saju: s.users,
      ref: r.users,
      total: s.users + r.users,
      sajuAvgEngagement: s.avgEngagement,
      refAvgEngagement: r.avgEngagement,
      blog,
      refSites: rc ? rc.sites : null,
      refSections: rc ? rc.sections : null,
      sajuNewVsReturning: sRet,
      refNewVsReturning: rRet,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: String(err.message || err) });
  }
};
