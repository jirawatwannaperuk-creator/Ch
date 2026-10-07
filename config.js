/*
 * ตั้งค่าหน้าสแกน — แก้เฉพาะไฟล์นี้
 *
 * GAS_URL : ลิงก์ Web app ของ Google Apps Script (ได้จากการ Deploy) ลงท้ายด้วย /exec
 *           ตัวอย่าง https://script.google.com/macros/s/AKfycb.../exec
 *
 * ไม่ต้องใส่ PIN ในไฟล์นี้ — หน้าเว็บจะถามตอนเปิดครั้งแรก แล้วจำไว้ในเครื่องนั้น
 * (repo บน GitHub เป็นสาธารณะ ห้ามเขียน PIN ลงไฟล์)
 */
window.APP_CONFIG = {
  GAS_URL: "https://script.google.com/macros/s/AKfycbypb-aB5LS6F_rVCSOdoDbCaxtXlunJfPDaN3uHbd6FTxnZQ5LbFU_xDVekrRyJKSto3w/exec",

  FACE_INTERVAL: 900   // ตรวจใบหน้าทุกกี่มิลลิวินาที (เครื่องช้าให้เพิ่มเป็น 1200-1500)
};
