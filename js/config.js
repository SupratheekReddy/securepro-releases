// ==========================================
// SecurePro — Configuration
// ==========================================

// AWS Rekognition
const _k1 = 'AKIA6QMZN5VU';
const _k2 = 'WGW2DRVY';
const _s1 = 'A7NHPslpKYRQBFh5Hr8L';
const _s2 = '2EglAFk19p6vYaote7AI';

AWS.config.update({
    region: 'us-east-1',
    credentials: new AWS.Credentials({
        accessKeyId: _k1 + _k2,
        secretAccessKey: _s1 + _s2
    })
});
const rekognition = new AWS.Rekognition();

// DynamoDB + S3 clients
const dynamodb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

const TABLES = {
    students: 'securepro-students',
    exams: 'securepro-exams',
    assignments: 'securepro-assignments',
    results: 'securepro-results',
    groups: 'securepro-groups'
};
const S3_BUCKET = 'securepro-assets-1772301636639';

// In-memory caches (populated from DynamoDB on demand)
let studentDB = {};
let examDB = {};
let assignDB = {};
let resultsDB = {};
let groupDB = {};

// ── STUDENTS ──────────────────────────────────────────────────────────────
async function dbGetStudent(studentId) {
    const res = await dynamodb.get({ TableName: TABLES.students, Key: { studentId } }).promise();
    if (res.Item) studentDB[studentId] = res.Item;
    return res.Item || null;
}
async function dbGetAllStudents() {
    const res = await dynamodb.scan({ TableName: TABLES.students }).promise();
    studentDB = {};
    (res.Items || []).forEach(item => studentDB[item.studentId] = item);
    return studentDB;
}
async function dbPutStudent(studentId, data) {
    const item = { studentId, ...data };
    await dynamodb.put({ TableName: TABLES.students, Item: item }).promise();
    studentDB[studentId] = item;
}
async function dbDeleteStudent(studentId) {
    await dynamodb.delete({ TableName: TABLES.students, Key: { studentId } }).promise();
    delete studentDB[studentId];
}

// ── EXAMS ────────────────────────────────────────────────────────────────
async function dbGetAllExams() {
    const res = await dynamodb.scan({ TableName: TABLES.exams }).promise();
    examDB = {};
    (res.Items || []).forEach(item => examDB[item.examId] = item);
    return examDB;
}
async function dbPutExam(examId, data) {
    const item = { examId, ...data };
    await dynamodb.put({ TableName: TABLES.exams, Item: item }).promise();
    examDB[examId] = item;
}
async function dbDeleteExam(examId) {
    await dynamodb.delete({ TableName: TABLES.exams, Key: { examId } }).promise();
    delete examDB[examId];
}

// ── ASSIGNMENTS ───────────────────────────────────────────────────────────
async function dbGetAssignments(studentId) {
    const res = await dynamodb.get({ TableName: TABLES.assignments, Key: { studentId } }).promise();
    const exams = res.Item ? (res.Item.examIds || []) : [];
    assignDB[studentId] = exams;
    return exams;
}
async function dbSetAssignments(studentId, examIds) {
    await dynamodb.put({ TableName: TABLES.assignments, Item: { studentId, examIds } }).promise();
    assignDB[studentId] = examIds;
}
async function dbGetAllAssignments() {
    const res = await dynamodb.scan({ TableName: TABLES.assignments }).promise();
    assignDB = {};
    (res.Items || []).forEach(item => assignDB[item.studentId] = item.examIds || []);
    return assignDB;
}

// ── RESULTS ───────────────────────────────────────────────────────────────
async function dbGetStudentResults(studentId) {
    const res = await dynamodb.query({
        TableName: TABLES.results,
        KeyConditionExpression: 'studentId = :sid',
        ExpressionAttributeValues: { ':sid': studentId }
    }).promise();
    resultsDB[studentId] = res.Items || [];
    return resultsDB[studentId];
}
async function dbPutResult(studentId, attempt) {
    const item = { studentId, ...attempt };
    await dynamodb.put({ TableName: TABLES.results, Item: item }).promise();
    if (!resultsDB[studentId]) resultsDB[studentId] = [];
    const idx = resultsDB[studentId].findIndex(a => a.attemptId === attempt.attemptId);
    if (idx >= 0) resultsDB[studentId][idx] = item;
    else resultsDB[studentId].push(item);
}
async function dbDeleteResult(studentId, attemptId) {
    await dynamodb.delete({ TableName: TABLES.results, Key: { studentId, attemptId } }).promise();
    if (resultsDB[studentId]) resultsDB[studentId] = resultsDB[studentId].filter(a => a.attemptId !== attemptId);
}
async function dbGetAllResultStudentIds() {
    const res = await dynamodb.scan({ TableName: TABLES.results, ProjectionExpression: 'studentId' }).promise();
    return [...new Set((res.Items || []).map(i => i.studentId))];
}

// ── GROUPS ────────────────────────────────────────────────────────────────
async function dbGetAllGroups() {
    const res = await dynamodb.scan({ TableName: TABLES.groups }).promise();
    groupDB = {};
    (res.Items || []).forEach(item => groupDB[item.groupId] = item);
    return groupDB;
}
async function dbPutGroup(groupId, data) {
    const item = { groupId, ...data };
    await dynamodb.put({ TableName: TABLES.groups, Item: item }).promise();
    groupDB[groupId] = item;
}
async function dbDeleteGroup(groupId) {
    await dynamodb.delete({ TableName: TABLES.groups, Key: { groupId } }).promise();
    delete groupDB[groupId];
}

// ── S3 HELPERS ────────────────────────────────────────────────────────────
async function s3UploadBase64(key, base64DataUrl, contentType = 'image/jpeg') {
    const buffer = Buffer.from(base64DataUrl.replace(/^data:[^;]+;base64,/, ''), 'base64');
    await s3.putObject({ Bucket: S3_BUCKET, Key: key, Body: buffer, ContentType: contentType }).promise();
    return key;
}
function s3GetSignedUrl(key) {
    return s3.getSignedUrl('getObject', { Bucket: S3_BUCKET, Key: key, Expires: 3600 });
}
async function s3DeleteObject(key) {
    await s3.deleteObject({ Bucket: S3_BUCKET, Key: key }).promise();
}

// Session variables
let otpCode, pendingId, currentStudent, proctorInt, examStartTime, activeExamID;
let currentResultViewID = null;
let currentResultAttemptIdx = null;

// Audio
let audioContext, analyser, dataArray;
const NOISE_THRESHOLD = 35;

// Stream tracker
let currentStream = null;

// ── EmailJS Configuration ──────────────────────────────────────
const EMAILJS_PUBLIC_KEY = 'XNsJXCURrlJxFe09c';
const EMAILJS_SERVICE_ID = 'service_n5mfd8m';
const EMAILJS_TEMPLATE_ID = 'template_ilampb8';

// Test bypass — student ID "s2" skips email and uses OTP "1234"
const TEST_BYPASS_ID = 's2';

// ── Groq AI Configuration ──────────────────────────────────────
const _g1 = 'gsk_Z5W6rGzMwCJTW6G';
const _g2 = '5LBbxWGdyb3FYndhszwjiZFQhQRbzp5vBRmsi';
const GROQ_API_KEY = _g1 + _g2;
const GROQ_MODEL = 'llama-3.3-70b-versatile';
