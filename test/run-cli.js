#!/usr/bin/env node
// 테스트 전용 실행기: 목 서버 주소를 코드로 지정한 뒤 실제 CLI를 실행한다.
// (src/cli.js는 환경변수로 API 주소를 바꿀 수 없으므로, 목 서버는 이 파일을 통해서만 쓸 수 있다.
//  이 파일은 npm 패키지에 포함되지 않는다.)
import { __setTestApiBase } from '../src/config.js';

if (process.env.TEST_MOCK_API_BASE) __setTestApiBase(process.env.TEST_MOCK_API_BASE);
await import('../src/cli.js');
