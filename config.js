// ============================================================
//  THE GREAT BRITISH GRIND — config
//  Edit this file to customise the game.
// ============================================================
window.APP_CONFIG = {
  title: "THE GREAT BRITISH GRIND",

  // Paste your Firebase web config here to share data between everyone.
  // Leave as null to run in LOCAL MODE (data only saved in this browser).
  // See README.md for the 5-minute setup.
  firebase: {
    apiKey: "AIzaSyB3ap9PlBOfaVgF5g6jTZgNNJ9kfClQ4kY",
    authDomain: "grind-tracker-3977e.firebaseapp.com",
    projectId: "grind-tracker-3977e",
    storageBucket: "grind-tracker-3977e.firebasestorage.app",
    messagingSenderId: "258860846223",
    appId: "1:258860846223:web:aac581018f41f58e8ef4fa",
  },

  // Firebase account IDs (uids) with the admin role. Must match the isAdmin() list in firestore.rules.
  admins: ["1mfuhvJ6QRTfVPnxg05DJe1eMMs1"],

  // Adjusted km earned per real km. Tweak to keep it fair.
  multipliers: {
    run: 1,
    cycle: 0.3,
    swim: 4,
  },

  // Adjusted km per level on the leaderboard
  kmPerLevel: 20,

  // Teams. Names, colours and who's on which team can be changed in-app ("EDIT SQUAD").
  teams: [
    { id: "t1", name: "TEAM RED", color: "#ff3355" },
    { id: "t2", name: "TEAM BLUE", color: "#3d7bff" },
  ],

  // The four players. Names, pics and teams can be changed in-app ("EDIT SQUAD").
  players: [
    { id: "p1", name: "PLAYER 1", color: "#00f0ff", team: "t1" },
    { id: "p2", name: "PLAYER 2", color: "#ff2bd6", team: "t1" },
    { id: "p3", name: "PLAYER 3", color: "#39ff14", team: "t2" },
    { id: "p4", name: "PLAYER 4", color: "#ffb800", team: "t2" },
  ],

  // The route: Land's End -> John o' Groats (~1,407 km by road).
  // Finish it and you start LAP 2.
  route: {
    name: "LAND'S END ➜ JOHN O' GROATS",
    totalKm: 1407,
    zones: [
      { name: "WORLD 1: ENGLAND", fromKm: 0, toKm: 820 },
      { name: "WORLD 2: SCOTLAND", fromKm: 820, toKm: 1407 },
    ],
    checkpoints: [
      { name: "Land's End", km: 0 },
      { name: "Exeter", km: 180 },
      { name: "Bristol", km: 300 },
      { name: "Birmingham", km: 440 },
      { name: "Manchester", km: 570 },
      { name: "Kendal", km: 690 },
      { name: "Scottish Border", km: 820 },
      { name: "Glasgow", km: 930 },
      { name: "Perth", km: 1035 },
      { name: "Inverness", km: 1210 },
      { name: "John o' Groats", km: 1407 },
    ],
  },
};
