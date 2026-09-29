const PDFDocument = require('pdfkit');
const {
  collectEarningRows,
  formatHours,
  resolveEarningYtd,
} = require('./payrollEarningRows');

function generateCheckPDF(payrollRun, employee, company, earningTypes, deductionTypes, ytd) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ 
        size: 'A4',
        margin: 0 
      });
      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ================== TRI-FOLD LAYOUT ==================
      // A4: 595.28 × 841.89 points
      // Panel 1 (Check):    0 - 280 points
      // Panel 2 (Employee): 280 - 560 points  
      // Panel 3 (Employer): 560 - 840 points

      const PANEL_HEIGHT = 280;
      const PANEL_1_START = 0;    // Check
      const PANEL_2_START = 280;  // Employee Stub
      const PANEL_3_START = 560;  // Employer Stub

      // ✅ USE CUSTOM POSITIONS OR DEFAULTS
      const defaultPositions = {
        date: { x: 480, y: 70, fontSize: 10 },
        amountWords: { x: 90, y: 110, fontSize: 10 },
        amountNumber: { x: 455, y: 108, fontSize: 14 },
        payeeName: { x: 90, y: 145, fontSize: 11 },
        payeeAddress: { x: 90, y: 160, fontSize: 9 },
        memo: { x: 90, y: 200, fontSize: 9 },
      };

      const positions = company.checkPositions || defaultPositions;

      // ================== PANEL 1: CHECK SECTION ==================
      
      // Prepare data
      const payDateFormatted = new Date(payrollRun.payDate).toLocaleDateString('en-US', { 
        month: 'short', 
        day: '2-digit', 
        year: 'numeric' 
      });
      
      const netPay = parseFloat(employee.netPay || 0);
      const netPayInWords = numberToWords(netPay);
      const cents = Math.round((netPay % 1) * 100);
      const formattedAmount = formatCurrency(netPay);
      const employeeName = employee.employeeName || 'EMPLOYEE NAME MISSING';

      // 1. CHECK NUMBER
      // doc.fontSize(positions.checkNumber?.fontSize || 10)
      //    .font('Helvetica-Bold')
      //    .text(`Check #${employee.checkNumber}`, positions.checkNumber?.x || 480, positions.checkNumber?.y || 40);

      // 2. DATE
      doc.fontSize(positions.date?.fontSize || 10)
         .font('Helvetica')
         .text(payDateFormatted, positions.date?.x || 480, positions.date?.y || 70);

      // 3. AMOUNT IN WORDS
      doc.fontSize(positions.amountWords?.fontSize || 10)
         .font('Helvetica-Bold')
         .text(`${netPayInWords.toUpperCase()} AND ${cents}/100`, 
               positions.amountWords?.x || 90, 
               positions.amountWords?.y || 110, 
               { width: 350 });

      // 4. AMOUNT (NUMERIC)
      doc.fontSize(positions.amountNumber?.fontSize || 14)
         .font('Helvetica-Bold')
         .text(formattedAmount, 
               positions.amountNumber?.x || 455, 
               positions.amountNumber?.y || 108, 
               { width: 85, align: 'right' });

      // 5. PAYEE NAME
      // The PropMent cheque has no address slot under this line.
      // The employee address is printed on the pay stubs below.
      doc.fontSize(positions.payeeName?.fontSize || 11)
         .font('Helvetica-Bold')
         .text(employeeName.toUpperCase(), 
               positions.payeeName?.x || 90, 
               positions.payeeName?.y || 145);

      // 6. MEMO LINE (Optional)
      if (positions.memo && employee.memo) {
        doc.fontSize(positions.memo?.fontSize || 9)
           .font('Helvetica')
           .text(employee.memo, positions.memo?.x || 90, positions.memo?.y || 200, { width: 300 });
      }

      // ================== PERFORATED LINE (Panel 1 → Panel 2) ==================
      doc.fontSize(10).text('✂', 25, PANEL_2_START - 20);
      doc.fontSize(7).fillColor('#999')
         .text('- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -', 
               40, PANEL_2_START - 15);
      doc.fillColor('#000');

      // ================== PANEL 2: EMPLOYEE PAY STUB ==================
      
      renderPayStub(doc, PANEL_2_START, 'EMPLOYEE', payrollRun, employee, company, earningTypes, deductionTypes, ytd);

      // ================== PERFORATED LINE (Panel 2 → Panel 3) ==================
      doc.fontSize(10).text('✂', 25, PANEL_3_START - 20);
      doc.fontSize(7).fillColor('#999')
         .text('- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -', 
               40, PANEL_3_START - 15);
      doc.fillColor('#000');

      // ================== PANEL 3: EMPLOYER PAY STUB (COPY) ==================
      
      renderPayStub(doc, PANEL_3_START, 'EMPLOYER', payrollRun, employee, company, earningTypes, deductionTypes, ytd);

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

// ================== REUSABLE PAY STUB RENDERER ==================

function renderPayStub(doc, startY, copyType, payrollRun, employee, company, earningTypes, deductionTypes, ytd) {
  // ✅ SAFE YTD with defaults
  const safeYTD = ytd || {
    grossEarnings: 0,
    regularPay: 0,
    regularHours: 0,
    overtimePay: 0,
    overtimeHours: 0,
    ptoPay: 0,
    ptoHours: 0,
    driverPay: 0,
    driverHours: 0,
    federalTax: 0,
    stateTax: 0,
    fica: 0,
    medicare: 0,
    sdi: 0,
    calSavers: 0,
    totalTaxes: 0,
    healthInsurance: 0,
    dentalInsurance: 0,
    retirement401k: 0,
    totalDeductions: 0,
    netPay: 0,
    payPeriodsIncluded: 0,
  };

  const payDateFormatted = new Date(payrollRun.payDate).toLocaleDateString('en-US', { 
    month: 'short', 
    day: '2-digit', 
    year: 'numeric' 
  });

  // Header
  doc.fontSize(11).font('Helvetica-Bold')
     .text(`${copyType} PAY STUB - ${copyType === 'EMPLOYEE' ? 'Employee Copy' : 'Company Copy'}`, 
           50, startY + 10, { align: 'center', width: 495 });
  doc.moveTo(50, startY + 30).lineTo(545, startY + 30).stroke();

  // Company & Employee Info
  let currentY = startY + 40;
  doc.fontSize(8).font('Helvetica-Bold').text(company.name || '', 50, currentY);
  doc.fontSize(8).font('Helvetica').text(company.addressLine1 || '', 50, currentY + 10);
  if (company.city && company.state) {
    doc.text(`${company.city}, ${company.state} ${company.postalCode || ''}`.trim(), 50, currentY + 20);
  }

  // Pay Period Info (Right Side)
  doc.fontSize(8).font('Helvetica-Bold').text('Pay Date', 300, currentY);
  doc.font('Helvetica').text(payDateFormatted, 380, currentY);
  
  doc.font('Helvetica-Bold').text('Period From', 300, currentY + 10);
  doc.font('Helvetica').text(new Date(payrollRun.periodStart).toLocaleDateString(), 380, currentY + 10);
  
  doc.font('Helvetica-Bold').text('Period Ending', 300, currentY + 20);
  doc.font('Helvetica').text(new Date(payrollRun.periodEnd).toLocaleDateString(), 380, currentY + 20);

  // Employee Details
  currentY += 40;
  doc.fontSize(9).font('Helvetica-Bold').text(employee.employeeName || 'Employee', 50, currentY);
  let detailOffset = 12;
  doc.fontSize(8).font('Helvetica').text(employee.position || 'No position', 50, currentY + detailOffset);
  payeeAddressLines(employee).forEach((line) => {
    detailOffset += 10;
    doc.fontSize(8).font('Helvetica').text(line, 50, currentY + detailOffset, { width: 230 });
  });

  // Employee Pay Info (Right Side)
  const ptoUsed = parseFloat(employee.hoursData?.ptoHours || 0);
  const ptoBalance = parseFloat(employee.hoursData?.ptoHoursBalance || 0);
  doc.fontSize(8).font('Helvetica-Bold').text('PTO Used', 300, currentY);
  doc.font('Helvetica').text(`${ptoUsed.toFixed(2)} Hours`, 380, currentY);
  doc.font('Helvetica-Bold').text('PTO Balance', 300, currentY + 10);
  doc.font('Helvetica').text(`${ptoBalance.toFixed(2)} Hours`, 380, currentY + 10);
  
  doc.font('Helvetica-Bold').text('Rate', 300, currentY + 20);
  const payRate = employee.payrollDetails?.payRate || employee.payRate || '0.00';
  doc.font('Helvetica').text(employee.payType === 'salary' ? 'Salary' : `$${payRate} / HR`, 380, currentY + 20);

  // ================== EARNINGS & DEDUCTIONS TABLE ==================
  
  currentY += Math.max(40, detailOffset + 16);
  
  const tableTop = currentY;
  const tableBottom = currentY + 140;
  const centerDivider = 340;
  
  // Table borders
  doc.moveTo(50, tableTop).lineTo(545, tableTop).stroke();
  doc.moveTo(50, tableTop + 15).lineTo(545, tableTop + 15).stroke();
  doc.moveTo(centerDivider, tableTop).lineTo(centerDivider, tableBottom).stroke();
  
  currentY += 5;

  // ====== COLUMN HEADERS ======
  doc.fontSize(7).font('Helvetica-Bold');
  
  // Left side: Earnings
  doc.text('Earnings', 60, currentY, { width: 80 });
  doc.text('Hours', 150, currentY, { width: 40, align: 'right' });
  doc.text('Current', 200, currentY, { width: 50, align: 'right' });
  doc.text('YTD', 260, currentY, { width: 60, align: 'right' });

  // Right side: Deductions  
  doc.text('Deductions', 350, currentY);
  doc.text('Current', 450, currentY, { width: 50, align: 'right' });
  doc.text('YTD', 500, currentY, { width: 40, align: 'right' });

  currentY += 15;
  const dataStartY = currentY;

  // ====== EARNINGS DATA ======
  doc.fontSize(7).font('Helvetica');

  collectEarningRows(employee, earningTypes).forEach((row) => {
    doc.text(row.label, 60, currentY, { width: 80 });
    doc.text(formatHours(row.hours), 150, currentY, { width: 40, align: 'right' });
    doc.text(parseFloat(row.amount).toFixed(2), 200, currentY, { width: 50, align: 'right' });

    doc.text(resolveEarningYtd(row, safeYTD).toFixed(2), 260, currentY, { width: 60, align: 'right' });

    currentY += 10;
  });

  // Gross Earnings Total
  currentY += 5;
  doc.font('Helvetica-Bold').text('Gross Earnings', 60, currentY, { width: 80 });
  doc.text(parseFloat(employee.grossPay || 0).toFixed(2), 200, currentY, { width: 50, align: 'right' });
  doc.text(parseFloat(safeYTD.grossEarnings || 0).toFixed(2), 260, currentY, { width: 60, align: 'right' });

  // ====== DEDUCTIONS DATA (Right Column) ======
  currentY = dataStartY;
  doc.font('Helvetica');

  // Taxes
  if (employee.taxes) {
    const taxTypes = [
      { key: 'federalTax', label: 'Fed Income Tax', ytdKey: 'federalTax' },
      { key: 'fica', label: 'FICA', ytdKey: 'fica' },
      { key: 'medicare', label: 'Medicare', ytdKey: 'medicare' },
      { key: 'stateTax', label: 'State Income Tax', ytdKey: 'stateTax' },
      { key: 'sdi', label: 'SDI', ytdKey: 'sdi' },
      { key: 'calSavers', label: 'CalSavers', ytdKey: 'calSavers' },
    ];

    taxTypes.forEach(({ key, label, ytdKey }) => {
      if (employee.taxes[key] > 0) {
        doc.text(label, 350, currentY, { width: 90 });
        doc.text(parseFloat(employee.taxes[key]).toFixed(2), 450, currentY, { width: 50, align: 'right' });
        
        // ✅ YTD from safeYTD object
        const ytdAmount = safeYTD[ytdKey] || 0;
        doc.text(parseFloat(ytdAmount).toFixed(2), 500, currentY, { width: 40, align: 'right' });
        currentY += 10;
      }
    });
  }

  // Other Deductions
  if (employee.deductions && deductionTypes) {
    Object.entries(employee.deductions).forEach(([deductionTypeId, value]) => {
      if (parseFloat(value) > 0) {
        const deductionType = deductionTypes.find(dt => dt.id === deductionTypeId);
        const label = deductionType ? deductionType.label : 'Other';
        
        doc.text(label, 350, currentY, { width: 90 });
        doc.text(parseFloat(value).toFixed(2), 450, currentY, { width: 50, align: 'right' });
        
        // ✅ YTD from safeYTD object
        const ytdField = deductionTypeId.replace(/([A-Z])/g, (match) => match.toLowerCase());
        const ytdAmount = safeYTD[ytdField] || 0;
        doc.text(parseFloat(ytdAmount).toFixed(2), 500, currentY, { width: 40, align: 'right' });
        currentY += 10;
      }
    });
  }

  // Total Deductions
  currentY += 5;
  const totalDeductions = parseFloat(employee.totalTaxes || 0) + parseFloat(employee.totalDeductions || 0);
  const totalDeductionsYTD = parseFloat(safeYTD.totalTaxes || 0) + parseFloat(safeYTD.totalDeductions || 0);
  
  doc.font('Helvetica-Bold').text('Total Deductions', 350, currentY, { width: 90 });
  doc.text(totalDeductions.toFixed(2), 450, currentY, { width: 50, align: 'right' });
  doc.text(totalDeductionsYTD.toFixed(2), 500, currentY, { width: 40, align: 'right' });

  // ====== NET PAY ======
  currentY += 15;
  doc.moveTo(50, currentY).lineTo(545, currentY).stroke();
  currentY += 8;
  
  doc.fontSize(9).font('Helvetica-Bold').text('Net Pay', 350, currentY, { width: 90 });
  doc.text(parseFloat(employee.netPay || 0).toFixed(2), 450, currentY, { width: 50, align: 'right' });
  doc.text(parseFloat(safeYTD.netPay || 0).toFixed(2), 500, currentY, { width: 40, align: 'right' });

  // Bottom border
  currentY += 15;
  doc.moveTo(50, currentY).lineTo(545, currentY).stroke();

  // ====== FOOTER ======
  currentY += 10;
  doc.fontSize(6).font('Helvetica').fillColor('#666');
  doc.text(
    `Generated by BizBuddy • ${new Date().toLocaleDateString()} • YTD: ${safeYTD.payPeriodsIncluded || 0} pay periods`, 
    50, currentY, 
    { align: 'left', width: 495 }
  );
  doc.fillColor('#000');
}

// ================== HELPER FUNCTIONS ==================

function payeeAddressLines(employee) {
  const street = employee.address || '';
  const cityState = [employee.city, employee.state].filter(Boolean).join(', ');
  const cityLine = [cityState, employee.postalCode].filter(Boolean).join(' ');
  return [street, cityLine].filter(Boolean);
}

function formatCurrency(num) {
  return num.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function numberToWords(num) {
  const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const teens = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const thousands = ['', 'thousand', 'million'];

  if (num === 0) return 'zero';

  let intPart = Math.floor(num);
  let words = '';

  let i = 0;
  while (intPart > 0) {
    const chunk = intPart % 1000;
    if (chunk !== 0) {
      const chunkWords = convertChunk(chunk, ones, teens, tens);
      words = chunkWords + (thousands[i] ? ' ' + thousands[i] : '') + (words ? ' ' + words : '');
    }
    intPart = Math.floor(intPart / 1000);
    i++;
  }

  return words.trim();
}

function convertChunk(num, ones, teens, tens) {
  let str = '';
  
  const hundred = Math.floor(num / 100);
  const remainder = num % 100;
  
  if (hundred > 0) {
    str += ones[hundred] + ' hundred';
  }
  
  if (remainder >= 10 && remainder < 20) {
    str += (str ? ' ' : '') + teens[remainder - 10];
  } else {
    const ten = Math.floor(remainder / 10);
    const one = remainder % 10;
    
    if (ten > 0) {
      str += (str ? ' ' : '') + tens[ten];
    }
    if (one > 0) {
      str += (str ? ' ' : '') + ones[one];
    }
  }
  
  return str;
}

module.exports = generateCheckPDF;