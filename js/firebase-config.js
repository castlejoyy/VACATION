// ────────────────────────────────────────────────────────────────
// Firebase 프로젝트 설정
// ────────────────────────────────────────────────────────────────
// Firebase 콘솔(https://console.firebase.google.com) > 프로젝트 생성 >
// 프로젝트 설정(⚙️) > 일반 탭 > "내 앱" 에서 웹 앱을 추가하면
// 아래와 같은 형태의 설정 객체를 볼 수 있습니다. 그대로 복사해서
// 아래 값들을 채워 넣으세요. (자세한 순서는 README.md 참고)
//
// 값을 채우기 전까지 이 앱은 자동으로 "로컬 저장 모드"로 동작합니다.
// (이 브라우저에만 저장되고, 다른 사람과 실시간 공유는 되지 않아요)
window.FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT_ID-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
