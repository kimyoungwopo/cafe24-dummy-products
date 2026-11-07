#!/usr/bin/env node
// 테스트 전용 실행기: 목 서버 주소를 코드로 지정한 뒤 실제 CLI를 실행한다.
// (src/cli.js는 환경변수로 API 주소를 바꿀 수 없으므로, 목 서버는 이 파일을 통해서만 쓸 수 있다.
//  이 파일은 npm 패키지에 포함되지 않는다.)
import fs from 'node:fs';
import { __setTestApiBase, __setDnsLookup } from '../src/config.js';
import { __setUrlSink } from '../src/server.js';

// UI 테스트: 토큰이 든 접속 주소를 화면 대신 지정한 파일(600)로만 받는다.
if (process.env.TEST_UI_URL_FILE) __setUrlSink((url) => fs.writeFileSync(process.env.TEST_UI_URL_FILE, url, { mode: 0o600 }));

if (process.env.TEST_MOCK_API_BASE) __setTestApiBase(process.env.TEST_MOCK_API_BASE);
if (process.env.TEST_FAKE_DNS) __setDnsLookup(async (host) => (host.startsWith('nosuchshop.') ? Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' })) : {}));
await import('../src/cli.js');
