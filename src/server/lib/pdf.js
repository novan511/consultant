// PDF generation for research projects — extracted from index.js.
import { supabase } from '../supabase.js';
import { log } from './logger.js';

export async function generateProjectPDF(projectId) {
  try {
    const PDFDocument = (await import('pdfkit')).default;
    const { data: proj } = await supabase.from('projects').select('*').eq('id', projectId).single();
    if (!proj) {
      log('warn', 'pdf', `Project ${projectId} not found`);
      return;
    }
    const { data: phases } = await supabase.from('project_phases').select('*').eq('project_id', projectId).order('created_at', { ascending: true });
    const { data: comments } = await supabase.from('project_comments').select('*').eq('project_id', projectId);

    const chunks = [];
    const doc = new PDFDocument({ margin: 50 });
    doc.on('data', c => chunks.push(c));

    // Title page
    doc.fontSize(24).font('Helvetica-Bold').text('RESEARCH REPORT', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(18).font('Helvetica-Bold').text(proj.title, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(11).font('Helvetica').fillColor('#666').text('Professor Senate — Autonomous Research Division', { align: 'center' });
    doc.moveDown(0.2);
    doc.text(`Status: ${proj.status.toUpperCase()} | Phases: ${phases?.length || 0} | Generated: ${new Date().toISOString().slice(0, 10)}`, { align: 'center' });
    doc.moveDown(1);
    doc.fillColor('#000');

    // Vision
    doc.fontSize(13).font('Helvetica-Bold').text('Vision');
    doc.moveDown(0.2);
    doc.fontSize(11).font('Helvetica').text(proj.vision || 'N/A');
    doc.moveDown(0.5);

    // Description
    doc.fontSize(13).font('Helvetica-Bold').text('Description');
    doc.moveDown(0.2);
    doc.fontSize(11).font('Helvetica').text(proj.description || 'N/A');
    doc.moveDown(1);

    // Timeline of phases
    doc.fontSize(13).font('Helvetica-Bold').text('Research Timeline');
    doc.moveDown(0.3);
    for (const ph of (phases || [])) {
      if (doc.y > 700) doc.addPage();
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#666')
        .text(`[${ph.phase.toUpperCase()}] ${ph.professor_name} — ${new Date(ph.created_at).toLocaleDateString()}`);
      doc.moveDown(0.1);
      doc.fontSize(10).font('Helvetica').fillColor('#000').text(ph.content || 'No content');
      doc.moveDown(0.5);
    }

    // User comments
    if (comments?.length) {
      if (doc.y > 600) doc.addPage();
      doc.fontSize(13).font('Helvetica-Bold').text('User Comments & Feedback');
      doc.moveDown(0.3);
      for (const c of comments) {
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#066').text(`${c.author}:`);
        doc.fontSize(10).font('Helvetica').fillColor('#000').text(c.content);
        doc.moveDown(0.3);
      }
    }

    doc.end();
    return new Promise((resolve, reject) => {
      doc.on('end', async () => {
        try {
          const buffer = Buffer.concat(chunks);
          const filePath = `research-${projectId}.pdf`;
          const { error } = await supabase.storage
            .from('research-pdfs')
            .upload(filePath, buffer, { contentType: 'application/pdf', upsert: true });
          if (error) {
            log('warn', 'pdf', `Storage upload note: ${error.message}`);
          }
          const url = `${process.env.SUPABASE_URL}/storage/v1/object/public/research-pdfs/${filePath}`;
          await supabase.from('projects').update({ metadata: { pdf_url: url } }).eq('id', projectId);
          log('info', 'pdf', `Generated: ${proj.title}`);
          resolve();
        } catch (e) {
          log('error', 'pdf', `Post-generation error: ${e.message}`);
          resolve(); // Don't reject — PDF generation is best-effort
        }
      });
      doc.on('error', (e) => {
        log('error', 'pdf', `Document error: ${e.message}`);
        resolve();
      });
    });
  } catch (e) {
    log('error', 'pdf', `Error: ${e.message}`);
  }
}
