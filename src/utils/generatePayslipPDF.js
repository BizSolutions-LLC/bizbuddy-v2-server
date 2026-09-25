const PDFDocument = require('pdfkit');
const {
  collectEarningRows,
  formatHours,
  formatRate,
  resolveEarningRate,
  resolveEarningYtd,
} = require('./payrollEarningRows');

async function generatePayslipPDF(payrollRun, employee, company, earningTypes, deductionTypes, ytd) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40, size: 'LETTER' });
      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ============================================
      // PROFESSIONAL HEADER WITH BOX
      // ============================================
      
      // Top border box
      doc.rect(40, 40, 532, 60).stroke();
      
      // Company name - bold and prominent
      doc.fontSize(16).font('Helvetica-Bold').text(company.name || 'COMPANY NAME', 50, 50);
      
      // Company address
      if (company.addressLine1) {
        doc.fontSize(9).font('Helvetica').text(company.addressLine1, 50, 68);
        if (company.city && company.state) {
          doc.text(`${company.city}, ${company.state} ${company.postalCode || ''}`, 50, 80);
        }
      }

      // PAYSLIP title - right side
      doc.fontSize(18).font('Helvetica-Bold').text('EMPLOYEE PAY STATEMENT', 300, 50, { align: 'right', width: 262 });
      
      doc.moveDown(3);

      // ============================================
      // EMPLOYEE & PAY PERIOD INFO BOX
      // ============================================
      
      let boxY = 110;
      
      // Gray background box
      doc.rect(40, boxY, 532, 70).fillAndStroke('#f5f5f5', '#000');
      
      // Left column - Employee info
      doc.fillColor('#000').fontSize(8).font('Helvetica-Bold').text('EMPLOYEE', 50, boxY + 10);
      doc.fontSize(10).font('Helvetica-Bold').text(employee.employeeName, 50, boxY + 22);
      doc.fontSize(8).font('Helvetica').text(employee.position || 'No position', 50, boxY + 36);
      doc.fontSize(8).text(`Employee ID: ${employee.employeeId || 'N/A'}`, 50, boxY + 48);
      
      // Middle column - Pay period
      doc.fontSize(8).font('Helvetica-Bold').text('PAY PERIOD', 220, boxY + 10);
      doc.fontSize(8).font('Helvetica').text(
        `From: ${new Date(payrollRun.periodStart).toLocaleDateString('en-US', { 
          month: '2-digit', day: '2-digit', year: 'numeric' 
        })}`,
        220, boxY + 22
      );
      doc.text(
        `To: ${new Date(payrollRun.periodEnd).toLocaleDateString('en-US', { 
          month: '2-digit', day: '2-digit', year: 'numeric' 
        })}`,
        220, boxY + 36
      );
      
      // Right column - Pay info
      doc.fontSize(8).font('Helvetica-Bold').text('PAY DATE', 400, boxY + 10);
      doc.fontSize(10).font('Helvetica-Bold').text(
        new Date(payrollRun.payDate).toLocaleDateString('en-US', { 
          month: '2-digit', day: '2-digit', year: 'numeric' 
        }),
        400, boxY + 22
      );
      doc.fontSize(8).font('Helvetica').text(`Check #: ${employee.checkNumber}`, 400, boxY + 48);

      doc.moveDown(4);

      // ============================================
      // EARNINGS TABLE
      // ============================================
      
      let tableY = 195;
      
      // Section header with gray background
      doc.rect(40, tableY, 532, 20).fillAndStroke('#e8e8e8', '#000');
      doc.fillColor('#000').fontSize(11).font('Helvetica-Bold').text('EARNINGS', 50, tableY + 6);
      
      tableY += 20;
      
      // Column headers
      doc.rect(40, tableY, 532, 18).stroke();
      doc.fontSize(8).font('Helvetica-Bold');
      doc.text('DESCRIPTION', 50, tableY + 5);
      doc.text('HOURS', 280, tableY + 5, { width: 50, align: 'right' });
      doc.text('RATE', 340, tableY + 5, { width: 60, align: 'right' });
      doc.text('CURRENT', 410, tableY + 5, { width: 70, align: 'right' });
      doc.text('YTD', 490, tableY + 5, { width: 72, align: 'right' });
      
      tableY += 18;
      
      // Earnings data rows
      doc.fontSize(9).font('Helvetica');

      collectEarningRows(employee, earningTypes).forEach((row) => {
        doc.rect(40, tableY, 532, 16).stroke();

        doc.text(row.label, 50, tableY + 4);
        doc.text(formatHours(row.hours), 280, tableY + 4, { width: 50, align: 'right' });
        doc.text(formatRate(resolveEarningRate(employee, row)), 340, tableY + 4, { width: 60, align: 'right' });
        doc.text(parseFloat(row.amount).toFixed(2), 410, tableY + 4, { width: 70, align: 'right' });
        doc.text(resolveEarningYtd(row, ytd).toFixed(2), 490, tableY + 4, { width: 72, align: 'right' });

        tableY += 16;
      });
      
      // Gross pay total row - highlighted
      doc.rect(40, tableY, 532, 18).fillAndStroke('#f0f0f0', '#000');
      doc.fillColor('#000').fontSize(10).font('Helvetica-Bold');
      doc.text('GROSS PAY', 50, tableY + 5);
      doc.text(parseFloat(employee.grossPay).toFixed(2), 410, tableY + 5, { width: 70, align: 'right' });
      doc.text(parseFloat(ytd.grossEarnings).toFixed(2), 490, tableY + 5, { width: 72, align: 'right' });
      
      tableY += 25;

      // ============================================
      // TAXES TABLE
      // ============================================
      
      // Section header
      doc.rect(40, tableY, 532, 20).fillAndStroke('#e8e8e8', '#000');
      doc.fillColor('#000').fontSize(11).font('Helvetica-Bold').text('TAXES', 50, tableY + 6);
      
      tableY += 20;
      
      // Column headers
      doc.rect(40, tableY, 532, 18).stroke();
      doc.fontSize(8).font('Helvetica-Bold');
      doc.text('DESCRIPTION', 50, tableY + 5);
      doc.text('CURRENT', 410, tableY + 5, { width: 70, align: 'right' });
      doc.text('YTD', 490, tableY + 5, { width: 72, align: 'right' });
      
      tableY += 18;
      
      // Tax rows
      doc.fontSize(9).font('Helvetica');
      
      if (employee.taxes) {
        const taxItems = [
          { key: 'federalTax', label: 'Federal Income Tax', ytdKey: 'federalTax' },
          { key: 'stateTax', label: 'State Income Tax', ytdKey: 'stateTax' },
          { key: 'fica', label: 'Social Security (FICA)', ytdKey: 'fica' },
          { key: 'medicare', label: 'Medicare', ytdKey: 'medicare' },
          { key: 'sdi', label: 'State Disability Insurance (SDI)', ytdKey: 'sdi' },
          { key: 'calSavers', label: 'CalSavers', ytdKey: 'calSavers' },
        ];

        taxItems.forEach(({ key, label, ytdKey }) => {
          const currentValue = parseFloat(employee.taxes[key] || 0);
          if (currentValue > 0) {
            const ytdValue = parseFloat(ytd[ytdKey] || 0);
            
            doc.rect(40, tableY, 532, 16).stroke();
            
            doc.text(label, 50, tableY + 4);
            doc.text(currentValue.toFixed(2), 410, tableY + 4, { width: 70, align: 'right' });
            doc.text(ytdValue.toFixed(2), 490, tableY + 4, { width: 72, align: 'right' });
            
            tableY += 16;
          }
        });
      }
      
      // Total taxes row
      doc.rect(40, tableY, 532, 18).fillAndStroke('#f0f0f0', '#000');
      doc.fillColor('#000').fontSize(10).font('Helvetica-Bold');
      doc.text('TOTAL TAXES', 50, tableY + 5);
      doc.text(parseFloat(employee.totalTaxes || 0).toFixed(2), 410, tableY + 5, { width: 70, align: 'right' });
      doc.text(parseFloat(ytd.totalTaxes).toFixed(2), 490, tableY + 5, { width: 72, align: 'right' });
      
      tableY += 25;

      // ============================================
      // DEDUCTIONS TABLE (if any)
      // ============================================
      
      if (employee.deductions && employee.totalDeductions > 0) {
        doc.rect(40, tableY, 532, 20).fillAndStroke('#e8e8e8', '#000');
        doc.fillColor('#000').fontSize(11).font('Helvetica-Bold').text('DEDUCTIONS', 50, tableY + 6);
        
        tableY += 20;
        
        // Column headers
        doc.rect(40, tableY, 532, 18).stroke();
        doc.fontSize(8).font('Helvetica-Bold');
        doc.text('DESCRIPTION', 50, tableY + 5);
        doc.text('CURRENT', 410, tableY + 5, { width: 70, align: 'right' });
        doc.text('YTD', 490, tableY + 5, { width: 72, align: 'right' });
        
        tableY += 18;
        
        // Deduction rows
        doc.fontSize(9).font('Helvetica');
        
        Object.entries(employee.deductions).forEach(([deductionTypeId, value]) => {
          if (value > 0) {
            const deductionType = deductionTypes.find(dt => dt.id === deductionTypeId);
            const label = deductionType ? deductionType.label : 'Other Deduction';
            
            const ytdField = deductionTypeId.replace(/([A-Z])/g, (match) => match.toLowerCase());
            const ytdValue = ytd[ytdField] || 0;
            
            doc.rect(40, tableY, 532, 16).stroke();
            
            doc.text(label, 50, tableY + 4);
            doc.text(parseFloat(value).toFixed(2), 410, tableY + 4, { width: 70, align: 'right' });
            doc.text(parseFloat(ytdValue).toFixed(2), 490, tableY + 4, { width: 72, align: 'right' });
            
            tableY += 16;
          }
        });
        
        // Total deductions row
        doc.rect(40, tableY, 532, 18).fillAndStroke('#f0f0f0', '#000');
        doc.fillColor('#000').fontSize(10).font('Helvetica-Bold');
        doc.text('TOTAL DEDUCTIONS', 50, tableY + 5);
        doc.text(parseFloat(employee.totalDeductions).toFixed(2), 410, tableY + 5, { width: 70, align: 'right' });
        doc.text(parseFloat(ytd.totalDeductions).toFixed(2), 490, tableY + 5, { width: 72, align: 'right' });
        
        tableY += 25;
      }

      // ============================================
      // NET PAY - PROMINENT BOX
      // ============================================
      
      // Black border box with white background
      doc.rect(40, tableY, 532, 35).fillAndStroke('#ffffff', '#000');
      doc.lineWidth(2);
      doc.rect(40, tableY, 532, 35).stroke();
      doc.lineWidth(1);
      
      doc.fillColor('#000').fontSize(14).font('Helvetica-Bold');
      doc.text('NET PAY', 50, tableY + 11);
      
      doc.fontSize(16).font('Helvetica-Bold');
      doc.text(`$${parseFloat(employee.netPay).toFixed(2)}`, 410, tableY + 10, { width: 70, align: 'right' });
      doc.text(`$${parseFloat(ytd.netPay).toFixed(2)}`, 490, tableY + 10, { width: 72, align: 'right' });

      // ============================================
      // FOOTER
      // ============================================
      
      tableY += 50;
      
      // Separator line
      doc.moveTo(40, tableY).lineTo(572, tableY).stroke();
      
      tableY += 10;
      
      doc.fontSize(7).font('Helvetica').fillColor('#666');
      doc.text(
        'This is a computer-generated pay statement and does not require a signature.',
        40, tableY, 
        { align: 'center', width: 532 }
      );
      
      tableY += 12;
      
      doc.text(
        `Generated: ${new Date().toLocaleString('en-US', { 
          month: '2-digit', 
          day: '2-digit', 
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })} | Year-to-Date includes ${ytd.payPeriodsIncluded || 0} pay period(s) from ${new Date(payrollRun.periodEnd).getFullYear()}`,
        40, tableY,
        { align: 'center', width: 532 }
      );

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = generatePayslipPDF;