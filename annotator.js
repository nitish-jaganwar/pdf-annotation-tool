/* =============================================================
   — Annotation Utility  |  tbits
     File   : annotator.js
   - Added Page State Caching & Hierarchy (IRT)
   ============================================================= */

// ── CONSTANTS ──
const PALETTE = ['#ffffff', '#f04f5a','#f97316','#eab308','#18b87d','#0ea5e9','#3b6ef8','#8b5cf6','#ec4899','#1a2140','#8b96b8'];
const TYPE_LABELS = { rect:'Rectangle', circle:'Ellipse', draw:'Pencil', arrow:'Arrow', line:'Line', text:'Text' };

// ── SECURITY HELPER ──
function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, tag => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[tag] || tag));
}

// ── STATE ──
let currentUser      = 'nitish-test';
let currentUserId    = '007'; 
let currentUserEmail = 'test@tbits.com';
let currentDocumentId = 'DOC-test-123';

let canvas;
let fileType         = 'image';
let fileName         = 'Document';
let annotations      = [];
let annoCounter      = 1;
let currentTool      = 'select';
let activeAnnoId     = null;
let isDown, origX, origY, tempShape, tempLine, tempHead;
let currentColor     = '#3b6ef8';
let strokeWidth      = 2;
let currentZoom      = 1;
let pdfDoc           = null;
let pageNum          = 1;
let totalPages       = 1;
let originalPdfBytes = null;

let deletedImportedSignatures = new Set();
let pageData = {};
let isFileLoaded = false;

// ═══════════════════════════════════════════════════════════════
// SECTION 1 — BOOTSTRAP
// ═══════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
    initializeUserIdentity();
  
    //Document ID inilization logic here 


    canvas = new fabric.Canvas('doc-canvas', { selection: true });
    canvas.setWidth(800);
    canvas.setHeight(600);

    buildAllSwatches();
    setupTools();
    setupDrawing();
    setupSelection();
    updateToolbarState(false);
    setupContextMenu();
    setupSidebar();
    setupCommentInput();
    setupSliders();
    setupZoom();
    setupKeyboard();
    setupDragDrop();
    setupButtons();

    // Safely check if the element exists before adding event listener
    const userNameInput = document.getElementById('user-name-input');
    if (userNameInput) {
        userNameInput.addEventListener('keydown', e => {
            if (e.key === 'Enter')  confirmUserName();
            if (e.key === 'Escape') closeUserModal();
        });
    }

    renderList();
});



// ═══════════════════════════════════════════════════════════════
// SECTION 2 — FULL STATE RESET
// ═══════════════════════════════════════════════════════════════
function resetState() {
    annotations  = [];
    annoCounter  = 1;
    activeAnnoId = null;
    
    if (canvas) {
        canvas.clear();
        canvas.setZoom(1);
    }
    currentZoom = 1;

    pdfDoc           = null;
    pageNum          = 1;
    totalPages       = 1;
    originalPdfBytes = null;
    fileType         = 'image';
    
    deletedImportedSignatures.clear();
    pageData         = {};

    hideCommentInput();
    showNoSel();
    updateToolbarState(false);
    renderList();
    renderBadges();
    updateJsonState();

    document.getElementById('st-dims').textContent     = '—';
    document.getElementById('st-pos').textContent      = 'x:— y:—';
    document.getElementById('st-tool').textContent     = 'Select';
    document.getElementById('zoom-level').textContent  = '100%';
    document.getElementById('page-nav').style.display  = 'none';

    const banner = document.getElementById('import-banner');
    if (banner) banner.remove();

    const jp = document.getElementById('json-preview-panel');
    if (jp) jp.remove();
    
    isFileLoaded = false;
}

// ═══════════════════════════════════════════════════════════════
// SECTION 3 — USER IDENTITY
// ═══════════════════════════════════════════════════════════════

//: Read from Token OR Header 
function initializeUserIdentity() {
    // ---------------------------------------------------------
    // WAY 1: Try reading from JWT Token (Most Secure)
    // ---------------------------------------------------------
    const token = localStorage.getItem('app_token'); // 'app_token'  replace with our key name
    
    if (token) {
        try {
            // JWT Token has 3 parts (Header.Payload.Signature)
            // we use  (Payload) to  decode 
            const payload = JSON.parse(atob(token.split('.')[1])); 
            
            // Backend JSON keys set karein ( 'name', 'fullName', 'sub')
            currentUser      = payload.name || payload.fullName || 'Reviewer';
            currentUserId    = payload.sub || payload.userId || 'guest';
            currentUserEmail = payload.email || '';
            
            console.log('✅ Identity loaded from JWT Token:', currentUser);
            return; // Agar token mil gaya, toh function yahin rok do
        } catch (error) {
            console.warn('⚠️ Invalid JWT Token, falling back to Web Header...', error);
        }
    }

    // ---------------------------------------------------------
    // WAY 2: Fallback to Web Header (DOM Scraping)
    // ---------------------------------------------------------
    const headerUserNameElement = document.getElementById('header-user-name');
    if (headerUserNameElement && headerUserNameElement.innerText) {
        currentUser = headerUserNameElement.innerText.trim();
        
        //
        const headerUserIdElement = document.getElementById('header-user-id');
        currentUserId = headerUserIdElement ? headerUserIdElement.innerText.trim() : currentUser.toLowerCase().replace(/\s+/g, '_');
        
        console.log('✅ Identity loaded from Web Header:', currentUser);
        return;
    }

    // ---------------------------------------------------------
    // WAY 3: Final Fallback
    // ---------------------------------------------------------
    console.log('⚠️ No identity found. Defaulting to Guest/Reviewer.');
}
// ═══════════════════════════════════════════════════════════════
// SECTION 4 — COLOR SWATCHES
// ═══════════════════════════════════════════════════════════════
function buildAllSwatches() {
    buildSwatches(document.getElementById('props-colors'), c => applyColor(c));
    const ctxWrap = document.getElementById('ctx-colors');
    PALETTE.forEach(c => {
        const s = document.createElement('div');
        s.className = 'ctx-swatch'; s.style.background = c;
        s.onclick = () => { applyColor(c); hideCtx(); };
        ctxWrap.appendChild(s);
    });
}
function buildSwatches(container, onPick) {
    if(!container) return;
    PALETTE.forEach(c => {
        const s = document.createElement('div');
        s.className = 'cswatch'; s.style.background = c;
        s.onclick = () => {
            container.querySelectorAll('.cswatch').forEach(x => x.classList.remove('active'));
            s.classList.add('active');
            onPick(c);
        };
        container.appendChild(s);
    });
}

// ═══════════════════════════════════════════════════════════════
// SECTION 5 — FILE LOADING 
// ═══════════════════════════════════════════════════════════════
document.getElementById('file-upload').addEventListener('change', function (e) {
    if (e.target.files[0]) processFile(e.target.files[0]);
    this.value = '';
});

function setupDragDrop() {
    const cw = document.getElementById('canvas-wrapper');
    cw.addEventListener('dragover', e => e.preventDefault());
    cw.addEventListener('drop', e => {
        e.preventDefault();
        if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]);
    });
}

function processFile(file) {
    resetState();
    isFileLoaded = true;

    fileName = file.name.split('.').slice(0, -1).join('.');
    document.getElementById('file-name-display').textContent = file.name;
    document.getElementById('empty-state').style.display     = 'none';
    document.getElementById('scroll-container').style.display = 'block';
    showLoader(true);

    const reader = new FileReader();

    if (file.type === 'application/pdf') {
        fileType = 'pdf';
        reader.onload = async f => {
            const rawBuffer  = f.target.result;
            originalPdfBytes = rawBuffer.slice(0);  
            const pdfjsCopy  = rawBuffer.slice(0);  
            try {
                pdfDoc     = await pdfjsLib.getDocument({ data: new Uint8Array(pdfjsCopy) }).promise;
                totalPages = pdfDoc.numPages;
                pageNum    = 1;
                await renderPdfPage(pageNum);
                await recoverAnnotationsFromPdf(pageNum);
            } catch (e) {
                toast('Failed to load PDF: ' + e.message, '❌');
                showLoader(false);
            }
        };
        reader.readAsArrayBuffer(file);
    } else {
        fileType         = 'image';
        originalPdfBytes = null;
        reader.onload    = f => loadFabric(f.target.result);
        reader.readAsDataURL(file);
    }
}

// ═══════════════════════════════════════════════════════════════
// SECTION 6 — ANNOTATION RECOGNITION
// ═══════════════════════════════════════════════════════════════
async function recoverAnnotationsFromPdf(pageIndex) {
    if (!pdfDoc) return;

    try {
        const page  = await pdfDoc.getPage(pageIndex);
        const vp    = page.getViewport({ scale: 1.5 }); // for clear view
        const annots = await page.getAnnotations();

        const textAnnots = annots.filter(a => a.subtype === 'Text' || a.annotationType === 1);
        if (!textAnnots.length) return;

        const parents = [];
        const repliesRaw = [];
        textAnnots.forEach(a => a.inReplyTo ? repliesRaw.push(a) : parents.push(a));

        const idMapping = {}; 
        let recovered = 0;

        for (const raw of parents) {
            let text = raw.contentsObj?.str || raw.contents || '';
            const author = raw.titleObj?.str || raw.title || 'Unknown';
            let type = raw.titleObj?.str ? (raw.subject || 'Comment') : 'Comment';

            const typeMatch = text.match(/^#\d+\s+\[([^\]]+)\]/);
            if (typeMatch) {
                type = typeMatch[1]; 
                const authorIndex = text.indexOf('by ' + author);
                if (authorIndex !== -1) {
                    const cutPos = authorIndex + ('by ' + author).length;
                    text = text.substring(cutPos).trim();
                } else {
                    const firstNewLine = text.indexOf('\n');
                    if (firstNewLine !== -1) text = text.substring(firstNewLine + 1).trim();
                }
            }

            const rect = raw.rect; 
            if (!rect || rect.length < 4) continue;

            const pdfPageH = vp.height / 1.5;
            const cx = rect[0] * 1.5;
            const cy = (pdfPageH - rect[3]) * 1.5;
            const cw = Math.max((rect[2] - rect[0]) * 1.5, 40);
            const ch = Math.max((rect[3] - rect[1]) * 1.5, 40);

            const sig = Math.round(cx) + '_' + Math.round(cy); 
            if (deletedImportedSignatures?.has && deletedImportedSignatures.has(sig)) continue;  

            const pdfColor = raw.color;
            let hexColor = '#3b6ef8';
            if (pdfColor && pdfColor.length === 3) {
                hexColor = '#' + pdfColor.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
            }

            let fabricFill = 'transparent';
            if (hexColor !== '#ffffff') {
                const r = parseInt(hexColor.slice(1, 3), 16);
                const g = parseInt(hexColor.slice(3, 5), 16);
                const b = parseInt(hexColor.slice(5, 7), 16);
                if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
                    fabricFill = `rgba(${r}, ${g}, ${b}, 0.1)`;
                }
            }

            const marker = new fabric.Rect({
                left: cx, top: cy, width: cw, height: ch,
                stroke: hexColor, strokeWidth: 2, strokeDashArray: [6, 3],
                fill: fabricFill, transparentCorners: false,
                cornerColor: '#3b6ef8', cornerSize: 8, borderColor: '#3b6ef8',
            });

            const id = 'imported-' + Date.now() + '-' + recovered;
            marker.id = id;
            canvas.add(marker);
            idMapping[raw.id] = id; 
            const now = new Date().toISOString();

            annotations.push({
                id, number: annoCounter++, 
                type: type, 
                text: text, isDraft: false, color: hexColor, fabricType: 'rect',
                isImported: true, signature: sig, 
                
                // Tier 2 Mapping
                createdBy: { id: 'imported', name: author, email: '' },
                createdAt: now,
                date: new Date().toLocaleString(),
                lastEditedBy: null, lastEditedAt: null, editHistory: [], replies: []
            });
            recovered++;
        }

        for (const rep of repliesRaw) {
            const parentCustomId = idMapping[rep.inReplyTo];
            if (!parentCustomId) continue; 
            
            const parentObj = annotations.find(a => a.id === parentCustomId);
            if (parentObj) {
                const repAuthor = rep.titleObj?.str || rep.title || 'Reviewer';
                parentObj.replies.push({
                    id: 'rep-imp-' + Date.now() + Math.random(),
                    createdBy: { id: 'imported', name: repAuthor, email: '' },
                    createdAt: new Date().toISOString(),
                    date: new Date().toLocaleString(),
                    text: rep.contentsObj?.str || rep.contents || '',
                    isImported: true
                });
            }
        }

        canvas.renderAll();
        renderList();
        renderBadges();
        updateJsonState();

        if (recovered > 0) showImportBanner(recovered);

    } catch (err) {
        console.warn('Annotation recovery skipped:', err.message);
    }
}

function showImportBanner(count) {
    const existing = document.getElementById('import-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'import-banner';
    banner.innerHTML = `
        <span class="import-banner-icon">📥</span>
        <span><strong>${count} existing annotation${count > 1 ? 's' : ''}</strong> were recovered from this PDF and shown below.
        You can edit, delete, or add more.</span>
        <button class="import-banner-close" onclick="document.getElementById('import-banner').remove()">✕</button>`;

    const wrapper = document.getElementById('canvas-wrapper');
    wrapper.insertBefore(banner, wrapper.querySelector('#scroll-container'));
}

// ═══════════════════════════════════════════════════════════════
// SECTION 7 — PDF PAGE RENDERING & CACHING
// ═══════════════════════════════════════════════════════════════
async function renderPdfPage(n) {
    showLoader(true);
    const page = await pdfDoc.getPage(n);
    const vp   = page.getViewport({ scale: 1.5 });
    const tmp  = document.createElement('canvas');
    tmp.width  = vp.width; tmp.height = vp.height;
    
    await page.render({ 
        canvasContext: tmp.getContext('2d'), 
        viewport: vp, 
        annotationMode: 0 
    }).promise;
    
    await loadFabric(tmp.toDataURL('image/png'));
    updatePageNav();
}

function updatePageNav() {
    document.getElementById('page-nav').style.display = totalPages > 1 ? 'flex' : 'none';
    document.getElementById('page-label').textContent  = `${pageNum} / ${totalPages}`;
    document.getElementById('btn-prev').disabled        = pageNum <= 1;
    document.getElementById('btn-next').disabled        = pageNum >= totalPages;
}

async function changePage(dir) {
    const np = pageNum + dir;
    if (np < 1 || np > totalPages) return;

    pageData[pageNum] = {
        annotations: [...annotations],
        annoCounter: annoCounter,
        canvasData: canvas.toJSON(['id', 'transparentCorners', 'cornerColor', 'cornerSize', 'borderColor'])
    };

    pageNum = np;
    
    hideCommentInput(); showNoSel(); updateToolbarState(false);
    const banner = document.getElementById('import-banner');
    if (banner) banner.remove();

    await renderPdfPage(pageNum);

    if (pageData[pageNum]) {
        annotations = pageData[pageNum].annotations;
        annoCounter = pageData[pageNum].annoCounter;
        
        canvas.loadFromJSON(pageData[pageNum].canvasData, function() {
            canvas.renderAll();
            renderList();
            renderBadges();
            updateJsonState();
        });
    } else {
        annotations = []; 
        annoCounter = 1;
        await recoverAnnotationsFromPdf(pageNum);
        renderList();
        renderBadges();
        updateJsonState();
    }
}

function loadFabric(dataUrl) {
    return new Promise(resolve => {
        fabric.Image.fromURL(dataUrl, img => {
            canvas.clear();
            canvas.setZoom(currentZoom = 1);
            canvas.setWidth(img.width);
            canvas.setHeight(img.height);
            const shadow = document.getElementById('canvas-shadow');
            shadow.style.width  = img.width  + 'px';
            shadow.style.height = img.height + 'px';
            canvas.setBackgroundImage(img, canvas.renderAll.bind(canvas), { originX: 'left', originY: 'top' });
            document.getElementById('st-dims').textContent    = `${img.width} × ${img.height}px`;
            document.getElementById('zoom-level').textContent = '100%';
            showLoader(false);
            resolve();
        });
    });
}

function showLoader(v) { document.getElementById('loader').style.display = v ? 'flex' : 'none'; }

// ═══════════════════════════════════════════════════════════════
// SECTION 8 — TOOL SELECTION
// ═══════════════════════════════════════════════════════════════
function setupTools() {
    document.querySelectorAll('.tool-btn[data-tool]').forEach(b =>
        b.addEventListener('click', () => activateTool(b.dataset.tool))
    );
    document.querySelectorAll('.stroke-opt').forEach(o => {
        o.addEventListener('click', () => {
            document.querySelectorAll('.stroke-opt').forEach(x => x.classList.remove('active'));
            o.classList.add('active');
            strokeWidth = parseInt(o.dataset.w);
            if (canvas.isDrawingMode) canvas.freeDrawingBrush.width = strokeWidth;
        });
    });
}

function activateTool(tool) {
    currentTool = tool;
    document.querySelectorAll('.tool-btn[data-tool]')
        .forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
    canvas.isDrawingMode = (tool === 'draw');
    if (canvas.isDrawingMode) {
        canvas.freeDrawingBrush.color = currentColor;
        canvas.freeDrawingBrush.width = strokeWidth;
    }
    canvas.defaultCursor = tool === 'select' ? 'default' : 'crosshair';
    canvas.discardActiveObject(); canvas.renderAll();
    document.getElementById('st-tool').textContent = tool.charAt(0).toUpperCase() + tool.slice(1);
    hideCtx();
}

// ═══════════════════════════════════════════════════════════════
// SECTION 9 — DRAWING ON CANVAS
// ═══════════════════════════════════════════════════════════════
function setupDrawing() {
    canvas.on('mouse:move', o => {
        const p = canvas.getPointer(o.e);
        document.getElementById('st-pos').textContent = `x:${Math.round(p.x)} y:${Math.round(p.y)}`;
        if (!isDown) return;
        if (currentTool === 'rect') {
            if (origX > p.x) tempShape.set({ left: p.x });
            if (origY > p.y) tempShape.set({ top: p.y });
            tempShape.set({ width: Math.abs(origX - p.x), height: Math.abs(origY - p.y) });
        } else if (currentTool === 'circle') {
            tempShape.set({ rx: Math.abs(origX - p.x) / 2, ry: Math.abs(origY - p.y) / 2,
                left: origX > p.x ? p.x : origX, top: origY > p.y ? p.y : origY });
        } else if (currentTool === 'arrow') {
            tempLine.set({ x2: p.x, y2: p.y });
            tempHead.set({ left: p.x, top: p.y, angle: Math.atan2(p.y - origY, p.x - origX) * 180 / Math.PI + 90 });
        } else if (currentTool === 'line') {
            tempShape.set({ x2: p.x, y2: p.y });
        }
        canvas.renderAll();
    });

    canvas.on('mouse:down', o => {
        if (currentTool === 'select') return;
        if (!o.target) hideCommentInput();
        if (o.e.button === 2) return;
        isDown = true;
        const p   = canvas.getPointer(o.e);
        origX = p.x; origY = p.y;
        const cfg = { stroke: currentColor, strokeWidth, fill: 'transparent',
            transparentCorners: false, cornerColor: '#3b6ef8', cornerSize: 8, borderColor: '#3b6ef8' };

        if (currentTool === 'rect') {
            tempShape = new fabric.Rect({ left: origX, top: origY, width: 0, height: 0, ...cfg });
            canvas.add(tempShape);
        } else if (currentTool === 'circle') {
            tempShape = new fabric.Ellipse({ left: origX, top: origY, rx: 0, ry: 0, ...cfg });
            canvas.add(tempShape);
        } else if (currentTool === 'arrow') {
            tempLine = new fabric.Line([origX, origY, origX, origY], cfg);
            tempHead = new fabric.Triangle({ width: 12, height: 14, fill: currentColor,
                left: origX, top: origY, originX: 'center', originY: 'center', selectable: false });
            canvas.add(tempLine, tempHead);
        } else if (currentTool === 'line') {
            tempShape = new fabric.Line([origX, origY, origX, origY], cfg);
            canvas.add(tempShape);
        } else if (currentTool === 'text') {
            const txt = new fabric.IText('Text', { left: origX, top: origY, fontSize: 18,
                fill: currentColor, fontFamily: 'Plus Jakarta Sans',
                transparentCorners: false, cornerColor: '#3b6ef8', cornerSize: 8, borderColor: '#3b6ef8' });
            canvas.add(txt); txt.enterEditing(); txt.selectAll();
            finalizeAnno(txt, 'text'); isDown = false;
        }
    });

    canvas.on('mouse:up', () => {
        if (['select', 'draw', 'text'].includes(currentTool)) return;
        isDown = false;
        let shape = tempShape;
        if (currentTool === 'arrow') {
            if (Math.abs(origX - tempLine.x2) < 5 && Math.abs(origY - tempLine.y2) < 5) {
                canvas.remove(tempLine, tempHead); return;
            }
            canvas.remove(tempLine, tempHead);
            shape = new fabric.Group([tempLine, tempHead], {
                transparentCorners: false, cornerColor: '#3b6ef8', cornerSize: 8, borderColor: '#3b6ef8' });
            canvas.add(shape);
        } else if (['rect','circle'].includes(currentTool)) {
            if ((tempShape.width || 0) < 5 && (tempShape.height || 0) < 5) { canvas.remove(tempShape); return; }
        } else if (currentTool === 'line') {
            if (Math.abs(origX - tempShape.x2) < 5) { canvas.remove(tempShape); return; }
        }
        finalizeAnno(shape, currentTool);
    });

    canvas.on('path:created', e => {
        e.path.set({ transparentCorners: false, cornerColor: '#3b6ef8', cornerSize: 8, borderColor: '#3b6ef8' });
        finalizeAnno(e.path, 'draw');
    });

    canvas.on('after:render', () => renderBadges());
}

function finalizeAnno(obj, type) {
    activateTool('select');
    const id = 'anno-' + Date.now();
    obj.id = id;
    const now = new Date().toISOString();
    
    annotations.push({
        id, number: annoCounter++, 
        type: TYPE_LABELS[type] || type,
        date: new Date().toLocaleString(),
        text: '', isDraft: true, color: currentColor, fabricType: type,
        isImported: false,
        // Enterprise Identity Fields
        createdBy: { id: currentUserId, name: currentUser, email: currentUserEmail },
        createdAt: now,
        lastEditedBy: null,
        lastEditedAt: null,
        editHistory: [],
        replies: [] 
    });
    canvas.setActiveObject(obj);
    showCommentInput(id, true);
    updateJsonState();
}

// ═══════════════════════════════════════════════════════════════
// SECTION 10 — NUMBER BADGES
// ═══════════════════════════════════════════════════════════════
function renderBadges() {
    const layer = document.getElementById('anno-badges');
    if (!layer) return;
    layer.innerHTML = '';

    const pub = annotations.filter(a => !a.isDraft);
    pub.forEach(a => {
        const obj = canvas.getObjects().find(o => o.id === a.id);
        if (!obj) return;
        const b  = obj.getBoundingRect(true);
        const z  = currentZoom;
        const px = b.left * z;
        const py = b.top  * z;

        const pin = document.createElement('div');
        pin.className = 'anno-badge' + (a.id === activeAnnoId ? ' active-badge' : '')
                       + (a.isImported ? ' imported-badge' : '');
        pin.style.left       = (px - 8) + 'px';
        pin.style.top        = (py - 8) + 'px';
        pin.style.background = a.isImported
            ? `linear-gradient(135deg, ${a.color}, #8b5cf6)`
            : a.color;
        pin.style.width  = '20px';
        pin.style.height = '20px';
        pin.style.pointerEvents = 'all';

        const num = document.createElement('span');
        num.className   = 'anno-badge-num';
        num.textContent = a.number;
        pin.appendChild(num);

        pin.addEventListener('click', e => {
            e.stopPropagation();
            const fabricObj = canvas.getObjects().find(o => o.id === a.id);
            if (fabricObj) { canvas.setActiveObject(fabricObj); canvas.renderAll(); }
        });

        layer.appendChild(pin);
    });
}

// ═══════════════════════════════════════════════════════════════
// SECTION 11 — OBJECT SELECTION & PROPERTIES
// ═══════════════════════════════════════════════════════════════
function updateToolbarState(hasSelection) {
    const delBtn = document.getElementById('btn-toolbar-delete');
    if (!delBtn) return;
    delBtn.classList.toggle('has-selection', hasSelection);
    delBtn.style.opacity       = hasSelection ? '1'    : '0.35';
    delBtn.style.pointerEvents = hasSelection ? 'all'  : 'none';
}

function setupSelection() {
    canvas.on('selection:created', e => { onSel(e.selected[0]); updateToolbarState(true); });
    canvas.on('selection:updated', e => { onSel(e.selected[0]); updateToolbarState(true); });
    canvas.on('selection:cleared', () => { hideCtx(); hideCommentInput(); showNoSel(); updateToolbarState(false); });
}

function onSel(obj) {
    if (!obj) return;
    showPropsPanel(obj);
    if (obj.id) { activeAnnoId = obj.id; showCommentInput(obj.id, false); }
    renderBadges();
}

function showNoSel() {
    document.getElementById('no-sel').style.display     = 'flex';
    document.getElementById('props-panel').style.display = 'none';
    activeAnnoId = null;
    renderBadges();
}

function showPropsPanel(obj) {
    document.getElementById('no-sel').style.display     = 'none';
    document.getElementById('props-panel').style.display = 'block';
    const op = Math.round((obj.opacity || 1) * 100);
    document.getElementById('opacity-slider').value    = op;
    document.getElementById('opacity-val').textContent = op + '%';
    const sw = obj.strokeWidth || 2;
    document.getElementById('stroke-slider').value    = sw;
    document.getElementById('stroke-val').textContent = sw + 'px';
}

function applyColor(color) {
    currentColor = color;
    const obj = canvas.getActiveObject();
    if (obj) {
        if (obj.type === 'group') {
            obj.getObjects().forEach(c => {
                if (c.type === 'line')     c.set('stroke', color);
                if (c.type === 'triangle') c.set('fill',   color);
            });
        } else if (obj.type === 'i-text') {
            obj.set('fill', color);
        } else {
            obj.set('stroke', color);
        }
        canvas.renderAll();
        const anno = annotations.find(a => a.id === obj.id);
        if (anno) { anno.color = color; renderBadges(); }
    }
    if (canvas.isDrawingMode) canvas.freeDrawingBrush.color = color;
    document.getElementById('custom-color').value = color;
}

function setupSliders() {
    document.getElementById('custom-color').addEventListener('input', e => applyColor(e.target.value));
    document.getElementById('opacity-slider').addEventListener('input', e => {
        const v = parseInt(e.target.value);
        document.getElementById('opacity-val').textContent = v + '%';
        const obj = canvas.getActiveObject();
        if (obj) { obj.set('opacity', v / 100); canvas.renderAll(); }
    });
    document.getElementById('stroke-slider').addEventListener('input', e => {
        const v = parseInt(e.target.value);
        document.getElementById('stroke-val').textContent = v + 'px';
        strokeWidth = v;
        const obj = canvas.getActiveObject();
        if (!obj) return;
        if (obj.type === 'group') obj.getObjects().forEach(c => { if (c.type === 'line') c.set('strokeWidth', v); });
        else obj.set('strokeWidth', v);
        canvas.renderAll();
    });
}

// ═══════════════════════════════════════════════════════════════
// SECTION 12 — CONTEXT MENU
// ═══════════════════════════════════════════════════════════════
function setupContextMenu() {
    canvas.on('mouse:down', o => {
        if (o.e.button === 2 && o.target?.id) { o.e.preventDefault(); showCtx(o.e.clientX, o.e.clientY); }
        else if (o.e.button !== 2) hideCtx();
    });
    document.getElementById('canvas-wrapper').addEventListener('contextmenu', e => e.preventDefault());
    document.addEventListener('click', e => {
        if (!document.getElementById('context-menu').contains(e.target)) hideCtx();
    });
}
function showCtx(x, y) {
    const m = document.getElementById('context-menu');
    m.style.display = 'block'; m.style.left = x + 'px'; m.style.top = y + 'px';
}
function hideCtx() { document.getElementById('context-menu').style.display = 'none'; }

window.deleteActiveObject = function () {
    const obj = canvas.getActiveObject(); if (!obj) return;
    
    if (obj.id && obj.id.startsWith('imported-')) {
        const sigId = obj.id;
        const matched = annotations.find(a => a.id === sigId);
        if (matched && matched.signature) deletedImportedSignatures.add(matched.signature);
    }

    canvas.remove(obj);
    annotations = annotations.filter(a => a.id !== obj.id);
    hideCtx(); hideCommentInput(); renderList(); renderBadges(); canvas.renderAll();
    updateJsonState();
    toast('Annotation deleted', '🗑');
};

window.duplicateObject = function () {
    const obj = canvas.getActiveObject(); if (!obj) return;
    obj.clone(clone => {
        clone.set({ left: obj.left + 20, top: obj.top + 20, id: 'anno-' + Date.now() });
        const orig = annotations.find(a => a.id === obj.id);
        if (orig) {
            annotations.push({ 
                ...orig, 
                id: clone.id, 
                number: annoCounter++, 
                isDraft: false, 
                isImported: false, 
                createdBy: { id: currentUserId, name: currentUser, email: currentUserEmail },
                createdAt: new Date().toISOString(),
                replies: [] 
            });
        }
        canvas.add(clone); canvas.setActiveObject(clone); canvas.renderAll();
        renderList(); renderBadges(); updateJsonState();
    });
    hideCtx(); toast('Duplicated', '⧉');
};

window.editActiveComment = function () {
    const obj = canvas.getActiveObject();
    if (obj?.id) showCommentInput(obj.id, false);
    hideCtx();
};

// ═══════════════════════════════════════════════════════════════
// SECTION 13 — SIDEBAR TABS
// ═══════════════════════════════════════════════════════════════
function setupSidebar() {
    document.querySelectorAll('.sidebar-tab').forEach(t => {
        t.addEventListener('click', () => {
            document.querySelectorAll('.sidebar-tab').forEach(x => x.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(x => x.classList.remove('active'));
            t.classList.add('active');
            document.getElementById('tab-' + t.dataset.tab).classList.add('active');
        });
    });
}

// ═══════════════════════════════════════════════════════════════
// SECTION 14 — COMMENT INPUT & CARD LIST
// ═══════════════════════════════════════════════════════════════
function setupCommentInput() {
    document.getElementById('btn-cancel-input').addEventListener('click', cancelInput);
    document.getElementById('btn-post-input').addEventListener('click', postComment);
    document.getElementById('comment-textarea').addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) postComment();
    });
}

function showCommentInput(id, isNew) {
    activeAnnoId = id;
    const anno = annotations.find(a => a.id === id);
    document.getElementById('comment-input-section').style.display = 'block';
    document.getElementById('input-label').textContent              = isNew ? 'New Comment' : 'Edit Comment';
    document.getElementById('comment-textarea').value               = anno?.text || '';
    setTimeout(() => document.getElementById('comment-textarea').focus(), 50);
    renderList();
}

function hideCommentInput() {
    document.getElementById('comment-input-section').style.display = 'none';
    activeAnnoId = null;
    renderList();
}

function cancelInput() {
    const idx = annotations.findIndex(a => a.id === activeAnnoId);
    if (idx > -1 && annotations[idx].isDraft) {
        const obj = canvas.getObjects().find(o => o.id === activeAnnoId);
        if (obj) canvas.remove(obj);
        annotations.splice(idx, 1);
    }
    hideCommentInput(); hideCtx(); canvas.discardActiveObject(); canvas.renderAll();
    renderBadges(); updateJsonState();
}

function postComment() {
    const val = document.getElementById('comment-textarea').value.trim();
    if (!val) return;
    
    const anno = annotations.find(a => a.id === activeAnnoId);
    if (anno) { 
        const now = new Date().toISOString();
        
        // History Tracking
        if (!anno.isDraft && anno.text !== val && anno.text !== '') {
            anno.editHistory.push({
                by: anno.lastEditedBy ? anno.lastEditedBy.name : (anno.createdBy ? anno.createdBy.name : 'Unknown'),
                at: anno.lastEditedAt || anno.createdAt || now,
                text: anno.text
            });
            anno.lastEditedBy = { id: currentUserId, name: currentUser };
            anno.lastEditedAt = now;
        }
        
        anno.text = val; 
        anno.isDraft = false; 
        anno.date = new Date().toLocaleString(); 
    }
    
    hideCommentInput(); canvas.discardActiveObject(); canvas.renderAll();
    renderBadges(); updateJsonState();
    toast('Comment saved', '💬');
}

window.editComment = id => {
    const obj = canvas.getObjects().find(o => o.id === id);
    if (obj) { canvas.setActiveObject(obj); canvas.renderAll(); }
    showCommentInput(id, false);
};

window.deleteComment = id => {
    const anno = annotations.find(a => a.id === id);
    if (anno && anno.isImported && anno.signature) {
        deletedImportedSignatures.add(anno.signature);
    }

    const obj = canvas.getObjects().find(o => o.id === id);
    if (obj) canvas.remove(obj);
    annotations = annotations.filter(a => a.id !== id);
    canvas.renderAll(); renderList(); renderBadges(); updateJsonState();
    toast('Deleted', '🗑');
};

window.addReply = function(parentId) {
    const input = document.getElementById(`reply-input-${parentId}`);
    if (!input) return;
    
    const text = input.value.trim();
    if (!text) return;
    
    const parent = annotations.find(a => a.id === parentId);
    if (parent) {
        if (!parent.replies) parent.replies = [];
        parent.replies.push({
            id: 'rep-' + Date.now(),
            createdBy: {
                id: currentUserId,
                name: currentUser,
                email: currentUserEmail
            },
            createdAt: new Date().toISOString(),
            date: new Date().toLocaleString(),
            text: text,
            isImported: false
        });
        
        input.value = ''; 
        renderList();
        updateJsonState();
        toast('Reply added', '💬');
    }
};

function renderList() {
    const pub  = annotations.filter(a => !a.isDraft);
    document.getElementById('comment-count').textContent = pub.length;
    const list = document.getElementById('comments-list');

    if (!pub.length && document.getElementById('comment-input-section').style.display === 'none') {
        list.innerHTML = `<div class="empty-comments">
            <div class="empty-comments-icon">💬</div>
            <div class="empty-comments-text">No comments yet.<br>Draw a shape to annotate.</div>
        </div>`;
        return;
    }

    list.innerHTML = '';
    pub.forEach(a => {
        const card = document.createElement('div');
        card.className = 'comment-card' + (a.id === activeAnnoId ? ' active' : '');

        const originTag = a.isImported
            ? `<span class="cc-origin-tag imported">📥 Imported</span>`
            : `<span class="cc-origin-tag new">✏ New</span>`;

        let repliesHTML = '';
        if (a.replies && a.replies.length > 0) {
            repliesHTML = `<div class="cc-replies">` + 
                a.replies.map(rep => {
                    const repAuthor = rep.createdBy ? rep.createdBy.name : (rep.author || 'Reviewer');
                    return `
                    <div class="cc-reply-item">
                        <div class="cc-reply-header">
                            <span class="cc-reply-author">${escapeHTML(repAuthor)}</span>
                            <span class="cc-reply-date">${(rep.date || rep.createdAt || '').split(',')[0]}</span>
                        </div>
                        <div class="cc-reply-text">${escapeHTML(rep.text)}</div>
                    </div>
                `}).join('') + `</div>`;
        }

        const replyInputHTML = `
            <div class="cc-reply-input-wrap" onclick="event.stopPropagation()">
                <input type="text" id="reply-input-${a.id}" class="cc-reply-input" placeholder="Write a reply...">
                <button class="cc-reply-btn" onclick="addReply('${a.id}')">Reply</button>
            </div>
        `;

        const mainAuthor = a.createdBy ? a.createdBy.name : (a.author || 'Reviewer');
        card.innerHTML = `
            <div class="cc-top">
                <div class="cc-badge" style="background:${a.color}">${a.number}</div>
                <span class="cc-type-tag">${a.type}</span>
                ${originTag}
                <span class="cc-date">${(a.date || a.createdAt || '').split(',')[0]}</span>
            </div>
            <div class="cc-author"><span class="cc-author-icon">👤</span>${escapeHTML(mainAuthor)}</div>
            <div class="cc-body">${escapeHTML(a.text)}</div>
            ${repliesHTML}
            ${replyInputHTML}
            <div class="cc-actions">
                <button class="cc-btn"     data-action="edit"   data-id="${a.id}" title="Edit">✏</button>
                <button class="cc-btn del" data-action="delete" data-id="${a.id}" title="Delete">🗑</button>
            </div>`;
        
        card.addEventListener('click', e => {
            const btn = e.target.closest('.cc-btn');
            if (btn) {
                const id = btn.dataset.id;
                if (btn.dataset.action === 'edit')   editComment(id);
                if (btn.dataset.action === 'delete') deleteComment(id);
                return;
            }
            const obj = canvas.getObjects().find(o => o.id === a.id);
            if (obj) { canvas.setActiveObject(obj); canvas.renderAll(); }
        });
        list.appendChild(card);
    });
}

// ═══════════════════════════════════════════════════════════════
// SECTION 15 — JSON STATE
// ═══════════════════════════════════════════════════════════════
function getAnnotationsJSON() {
    pageData[pageNum] = {
        annotations: [...annotations],
        annoCounter: annoCounter,
        canvasData: canvas.toJSON(['id', 'transparentCorners', 'cornerColor', 'cornerSize', 'borderColor'])
    };

    let allPub = [];
    for (const [pStr, data] of Object.entries(pageData)) {
        const pubs = data.annotations.filter(a => !a.isDraft);
        pubs.forEach(a => {
            const objData = data.canvasData.objects.find(o => o.id === a.id);
            allPub.push({
                id:         a.id,
                number:     a.number,
                type:       a.type,
                color:      a.color,
                page:       parseInt(pStr),
                isImported: a.isImported || false,
                
                // Enterprise Identity Output
                createdBy:    a.createdBy || { name: a.author || 'Unknown' },
                createdAt:    a.createdAt || new Date().toISOString(),
                lastEditedBy: a.lastEditedBy || null,
                lastEditedAt: a.lastEditedAt || null,
                editHistory:  a.editHistory || [],
                text:         a.text,
                replies:      a.replies || [],
                
                bbox: objData ? {
                    x:      Math.round(objData.left),
                    y:      Math.round(objData.top),
                    width:  Math.round((objData.width || 0) * (objData.scaleX || 1)),
                    height: Math.round((objData.height || 0) * (objData.scaleY || 1))
                } : null
            });
        });
    }

    return {
        documentId: currentDocumentId,
        documentName: fileName,
        exportedAt:   new Date().toISOString(),
        reviewer:     { id: currentUserId, name: currentUser },
        totalPages,
        currentPage:  pageNum,
        annotations:  allPub
    };
}

function updateJsonState() {
    let totalAnnots = 0;
    const currentPub = annotations.filter(a => !a.isDraft);
    totalAnnots += currentPub.length;
    
    for (const [pStr, data] of Object.entries(pageData)) {
        if (parseInt(pStr) !== pageNum) {
            totalAnnots += data.annotations.filter(a => !a.isDraft).length;
        }
    }
    const jsCount = document.getElementById('st-json-count');
    if (jsCount) jsCount.textContent = `{ } ${totalAnnots} annotation${totalAnnots !== 1 ? 's' : ''}`;
}

// ═══════════════════════════════════════════════════════════════
// SECTION 16 — ZOOM
// ═══════════════════════════════════════════════════════════════
function setupZoom() {
    document.getElementById('canvas-wrapper').addEventListener('wheel', e => {
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); e.deltaY < 0 ? zoomIn() : zoomOut(); }
    }, { passive: false });
}
function zoomIn()    { currentZoom = Math.min(currentZoom + 0.15, 4);   applyZoom(); }
function zoomOut()   { currentZoom = Math.max(currentZoom - 0.15, 0.2); applyZoom(); }
function resetZoom() { currentZoom = 1; applyZoom(); }

function applyZoom() {
    canvas.setZoom(currentZoom);
    const baseW = canvas.backgroundImage ? canvas.backgroundImage.width  : 800;
    const baseH = canvas.backgroundImage ? canvas.backgroundImage.height : 600;
    const zW = Math.round(baseW * currentZoom);
    const zH = Math.round(baseH * currentZoom);
    canvas.setWidth(zW);
    canvas.setHeight(zH);
    const shadow = document.getElementById('canvas-shadow');
    shadow.style.width  = zW + 'px';
    shadow.style.height = zH + 'px';
    document.getElementById('zoom-level').textContent = Math.round(currentZoom * 100) + '%';
    renderBadges();
}

// ═══════════════════════════════════════════════════════════════
// SECTION 17 — KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════════════════
function setupKeyboard() {
    const KEYS = { v:'select', p:'draw', r:'rect', e:'circle', a:'arrow', t:'text', l:'line' };
    document.addEventListener('keydown', e => {
        if (['TEXTAREA','INPUT'].includes(e.target.tagName)) return;
        if (KEYS[e.key.toLowerCase()])                   { activateTool(KEYS[e.key.toLowerCase()]); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { if (canvas.getActiveObject()) deleteActiveObject(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key === 'z')  { undoLast(); }
        if ((e.ctrlKey || e.metaKey) && e.key === 'o')  { e.preventDefault(); document.getElementById('file-upload').click(); }
    });
}

function undoLast() {
    const objs = canvas.getObjects(); if (!objs.length) return;
    const last = objs[objs.length - 1];
    if (last.id) { annotations = annotations.filter(a => a.id !== last.id); renderList(); renderBadges(); updateJsonState(); }
    canvas.remove(last); canvas.renderAll();
    toast('Undone', '↩');
}

// ═══════════════════════════════════════════════════════════════
// SECTION 18 — TOAST & PROGRESS
// ═══════════════════════════════════════════════════════════════
function toast(msg, icon = '✅', dur = 2500) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span>${icon}</span><span>${escapeHTML(msg)}</span>`;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 200); }, dur);
}
function showProgress(v, title = 'Processing…', sub = 'Please wait') {
    document.getElementById('progress-bar-wrap').style.display = v ? 'flex' : 'none';
    document.getElementById('progress-title').textContent      = title;
    document.getElementById('progress-sub').textContent        = sub;
    if (!v) document.getElementById('progress-fill').style.width = '0%';
}
function setProgress(pct) { document.getElementById('progress-fill').style.width = pct + '%'; }

// ═══════════════════════════════════════════════════════════════
// SECTION 19 — BUTTON WIRING & FALLBACK PREVIEW
// ═══════════════════════════════════════════════════════════════
function checkFileLoaded() {
    if (!isFileLoaded) {
        toast('Please open a document first!', '⚠️');
        return false;
    }
    return true;
}

function setupButtons() {
    document.getElementById('btn-download').addEventListener('click', () => {
        if (checkFileLoaded()) handleDownload();
    });
    
    document.getElementById('btn-save-server').addEventListener('click', () => {
        if (checkFileLoaded()) handleSaveToServer();
    });
    
    document.getElementById('btn-export-summary').addEventListener('click', () => {
        if (checkFileLoaded()) handleSummary();
    });

    const viewJsonBtn = document.getElementById('btn-view-json');
    if (viewJsonBtn) {
        viewJsonBtn.addEventListener('click', () => {
            if (!checkFileLoaded()) return;
            syncCurrentPage(); 
            const jsonData = getAnnotationsJSON();
            showJsonPreview(jsonData); 
        });
    }

    const dwnJsonBtn = document.getElementById('btn-download-json');
    if (dwnJsonBtn) {
        dwnJsonBtn.addEventListener('click', () => {
            if (!checkFileLoaded()) return;
            syncCurrentPage();
            const jsonData = getAnnotationsJSON();
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(jsonData, null, 2));
            const downloadAnchorNode = document.createElement('a');
            downloadAnchorNode.setAttribute("href",     dataStr);
            downloadAnchorNode.setAttribute("download", fileName + "_annotations.json");
            document.body.appendChild(downloadAnchorNode); 
            downloadAnchorNode.click();
            downloadAnchorNode.remove();
            toast('JSON file downloaded!', '📄');
        });
    }
}

function showJsonPreview(payload) {
    const existing = document.getElementById('json-preview-panel');
    if (existing) existing.remove();
    
    const panel = document.createElement('div');
    panel.id = 'json-preview-panel';
    panel.style.cssText = `position:fixed;bottom:50px;right:16px;width:420px;max-height:320px;
        background:#1a2140;color:#c7d4fd;border-radius:12px;padding:16px;
        font-family:monospace;font-size:11px;line-height:1.6;
        overflow:auto;z-index:9999;box-shadow:0 12px 40px rgba(0,0,0,0.4);border:1.5px solid #3b6ef8;`;
        
    panel.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <span style="font-weight:700;color:#fff;font-size:12px">📋 Annotations JSON</span>
            <button onclick="document.getElementById('json-preview-panel').remove()"
                style="background:#3b6ef8;border:none;color:#fff;border-radius:6px;padding:3px 9px;cursor:pointer;font-size:11px">✕ Close</button>
        </div>
        <pre style="margin:0;white-space:pre-wrap;word-break:break-all">${JSON.stringify(payload, null, 2)}</pre>`;
        
    document.body.appendChild(panel);
}

function syncCurrentPage() {
    pageData[pageNum] = {
        annotations: [...annotations],
        annoCounter: annoCounter,
        canvasData: canvas.toJSON(['id', 'transparentCorners', 'cornerColor', 'cornerSize', 'borderColor'])
    };
}

async function handleDownload() {
    canvas.discardActiveObject(); canvas.renderAll();
    syncCurrentPage();
    
    showProgress(true, 'Building PDF…', 'Embedding annotations across all pages');
    setProgress(5);
    try {
        const pdfBytes = await buildAnnotatedPdf(p => setProgress(5 + p * 0.90));
        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
        const url  = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url; link.download = `${fileName}_Annotated.pdf`;
        link.click(); URL.revokeObjectURL(url);
        setProgress(100);
        setTimeout(() => showProgress(false), 500);
        toast(`Downloaded successfully`, '⬇');
    } catch (err) {
        showProgress(false); console.error(err);
        toast('Download failed: ' + err.message, '❌', 5000);
    }
}

async function handleSaveToServer() {
    canvas.discardActiveObject(); canvas.renderAll();
    syncCurrentPage();

    showProgress(true, 'Saving to Server…', 'Building PDF and uploading');
    setProgress(5);
    try {
        const pdfBytes    = await buildAnnotatedPdf(p => setProgress(5 + p * 0.70));
        const jsonPayload = getAnnotationsJSON();
        setProgress(80);

        const blob     = new Blob([pdfBytes], { type: 'application/pdf' });
        const formData = new FormData();
        formData.append('file',        blob,                        `${fileName}_Annotated.pdf`);
        formData.append('annotations', JSON.stringify(jsonPayload));
        formData.append('fileName',    fileName);
        formData.append('reviewer',    currentUser);
        setProgress(90);
       
        const SERVER_URL = 'http://192.168.1.4:8080/api/annotations/save';
        try {
            const response = await fetch(SERVER_URL, { method: 'POST', body: formData });
            setProgress(100);
            setTimeout(() => showProgress(false), 400);
            if (response.ok) toast(`Saved to server`, '☁');
            else toast(`Server error ${response.status}`, '❌', 5000);
        } catch (_) {
            showProgress(false);
            showJsonPreview(jsonPayload);
            toast('Server unreachable — JSON preview shown', '⚠️', 5000);
        }
    } catch (err) {
        showProgress(false); console.error(err);
        toast('Save failed: ' + err.message, '❌', 5000);
    }
}

async function handleSummary() {
    syncCurrentPage();
    
    let allPub = [];
    for (const [pStr, data] of Object.entries(pageData)) {
        const pagePub = data.annotations.filter(a => !a.isDraft).map(a => ({...a, page: parseInt(pStr)}));
        allPub.push(...pagePub);
    }

    if (!allPub.length) { toast('No annotations to export', '⚠️'); return; }
    
    try {
        const { PDFDocument, StandardFonts } = getPDFLib();
        const doc   = await PDFDocument.create();
        const fontR = await doc.embedFont(StandardFonts.Helvetica);
        const fontB = await doc.embedFont(StandardFonts.HelveticaBold);
        
        await drawSummaryPage(doc, allPub, fontR, fontB); 
        
        const bytes = await doc.save();
        const blob  = new Blob([bytes], { type: 'application/pdf' });
        const url   = URL.createObjectURL(blob);
        const link  = document.createElement('a');
        link.href = url; link.download = `${fileName}_Summary.pdf`;
        link.click(); URL.revokeObjectURL(url);
        toast('Summary PDF exported!', '📋');
    } catch (err) {
        console.error(err);
        toast('Export failed: ' + err.message, '❌', 4000);
    }
}

// ═══════════════════════════════════════════════════════════════
// SECTION 20 — PDF EXPORT HELPERS 
// ═══════════════════════════════════════════════════════════════
function getPDFLib() {
    const lib = window.PDFLib;
    if (!lib || !lib.PDFDocument) throw new Error('pdf-lib failed to load.');
    return lib;
}

function dataURLtoBytes(dataURL) {
    const binary = atob(dataURL.split(',')[1]);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function hexToRgb01(hex) {
    let h = (hex || '#3b6ef8').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length !== 6) h = '3b6ef8';
    const r = parseInt(h.substring(0, 2), 16) / 255;
    const g = parseInt(h.substring(2, 4), 16) / 255;
    const b = parseInt(h.substring(4, 6), 16) / 255;
    return [ isNaN(r) ? 0 : r, isNaN(g) ? 0 : g, isNaN(b) ? 1 : b ];
}

function toUTF16BEHex(str) {
    let hex = 'FEFF'; 
    for (let i = 0; i < str.length; i++) {
        hex += str.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
    }
    return hex;
}

async function buildAnnotatedPdf(onProgress = () => {}) {
    const lib = getPDFLib();
    const { PDFDocument, PDFName, PDFHexString, PDFString, rgb, StandardFonts } = lib;

    onProgress(5);
    let pdfDoc2;
    if (fileType === 'pdf' && originalPdfBytes) {
        pdfDoc2 = await PDFDocument.load(new Uint8Array(originalPdfBytes.slice(0)));
    } else {
        pdfDoc2 = await PDFDocument.create();
        const bgImg     = canvas.backgroundImage;
        const bgDataUrl = bgImg ? bgImg.toDataURL({ format:'png', quality:1 }) : canvas.toDataURL({ format:'png', quality:1 });
        const pngImage  = await pdfDoc2.embedPng(dataURLtoBytes(bgDataUrl));
        const pg        = pdfDoc2.addPage([pngImage.width, pngImage.height]);
        pg.drawImage(pngImage, { x:0, y:0, width:pngImage.width, height:pngImage.height });
    }
    
    const fontB = await pdfDoc2.embedFont(StandardFonts.HelveticaBold);
    onProgress(20);

    const pages = pdfDoc2.getPages();
    const totalPagesWithData = Object.keys(pageData).length;
    let processed = 0;

    for (const [pStr, data] of Object.entries(pageData)) {
        const pIndex = parseInt(pStr) - 1;
        if (pIndex < 0 || pIndex >= pages.length) continue;

        const pdfPage = pages[pIndex];
        const { width: pW, height: pH } = pdfPage.getSize();

        // Safe Cleanup (Deletes Text AND Popup so Adobe doesn't resurrect them)
        let annotsRef =  pdfPage.node.set(PDFName.of('Annots'), pdfDoc2.context.obj([]));
       
        let annotsArr;

        if (annotsRef) {
            let annotsObj = pdfDoc2.context.lookup(annotsRef); 
            if (annotsObj && typeof annotsObj.size === 'function') {
                const cleanArr = [];
                for (let i = 0; i < annotsObj.size(); i++) {
                    const ref = annotsObj.get(i);
                    const annot = pdfDoc2.context.lookup(ref);
                    if (annot) {
                        const stRef = annot.get(PDFName.of('Subtype'));
                        const stObj = pdfDoc2.context.lookup(stRef);
                        const subtypeName = stObj ? stObj.name : '';
                        if (subtypeName === 'Text' || subtypeName === 'Popup') {
                            continue; 
                        }
                    }
                    cleanArr.push(ref);
                }
                annotsArr = pdfDoc2.context.obj(cleanArr);
            } else {
                annotsArr = pdfDoc2.context.obj([]);
            }
            pdfPage.node.set(PDFName.of('Annots'), annotsArr);
        } else {
            annotsArr = pdfDoc2.context.obj([]);
            pdfPage.node.set(PDFName.of('Annots'), annotsArr);
        }
        
        const baseW = pW * 1.5; 
        const baseH = pH * 1.5;

        const pagePub = data.annotations.filter(a => !a.isDraft);
        const newAnnots = pagePub.filter(a => !a.isImported);

        if (newAnnots.length > 0 && data.canvasData) {
            const tmpEl = document.createElement('canvas');
            tmpEl.width = baseW; tmpEl.height = baseH;
            const tmpFabric = new fabric.StaticCanvas(tmpEl, { width: baseW, height: baseH });

            await new Promise(resolve => {
                tmpFabric.loadFromJSON(data.canvasData, () => {
                    tmpFabric.backgroundColor = null; 
                    tmpFabric.backgroundImage = null; 
                    const objects = tmpFabric.getObjects();
                    objects.forEach(obj => {
                        if (obj.id && obj.id.startsWith('imported-')) tmpFabric.remove(obj);
                    });
                    tmpFabric.renderAll();
                    resolve();
                });
            });

            const shapeDataUrl = tmpEl.toDataURL('image/png');
            const annotImage = await pdfDoc2.embedPng(dataURLtoBytes(shapeDataUrl));
            pdfPage.drawImage(annotImage, { x:0, y:0, width:pW, height:pH });
        }

        const scaleX = pW / baseW;
        const scaleY = pH / baseH;

        for (const anno of pagePub) {
            const objData = data.canvasData.objects.find(o => o.id === anno.id);
            if (!objData) continue;

            const x = objData.left * scaleX;
            const topY = pH - objData.top * scaleY; 
            const [cr, cg, cb] = hexToRgb01(anno.color);
            
            const badgeX = x;
            const badgeY = topY + 5;
            pdfPage.drawCircle({ x: badgeX, y: badgeY, size: 9, color: rgb(cr, cg, cb) });
            const numStr = String(anno.number);
            const textWidth = fontB.widthOfTextAtSize(numStr, 10);
            pdfPage.drawText(numStr, { x: badgeX - (textWidth / 2), y: badgeY - 3.5, size: 10, font: fontB, color: rgb(1, 1, 1) });

            const dateStr = new Date().toISOString().replace(/[-:.TZ]/g,'').substring(0,14);
            const tinyRect = pdfDoc2.context.obj([badgeX - 10, badgeY - 15, badgeX + 10, badgeY + 5]);

            const annoAuthorName = anno.createdBy ? anno.createdBy.name : (anno.author || 'Reviewer');

            const annotRef  = pdfDoc2.context.nextRef();
            const annotDict = pdfDoc2.context.obj({
                Type:     PDFName.of('Annot'),
                Subtype:  PDFName.of('Text'),
                Rect:     tinyRect, 
                Contents: PDFHexString.of(toUTF16BEHex(anno.text)),
                T:        PDFHexString.of(toUTF16BEHex(annoAuthorName)),
                Subj:     PDFHexString.of(toUTF16BEHex(anno.type)),
                M:        PDFString.of(`D:${dateStr}`),
                C:        pdfDoc2.context.obj([cr, cg, cb]),
                F:        pdfDoc2.context.obj(4),
                Name:     PDFName.of('Comment'),
                Open:     pdfDoc2.context.obj(false),
            });
            pdfDoc2.context.assign(annotRef, annotDict);
            annotsArr.push(annotRef);

            if (anno.replies && anno.replies.length > 0) {
                for (const rep of anno.replies) {
                    const repAuthorName = rep.createdBy ? rep.createdBy.name : (rep.author || 'Reviewer');
                    const repRef = pdfDoc2.context.nextRef();
                    const repDict = pdfDoc2.context.obj({
                        Type:     PDFName.of('Annot'),
                        Subtype:  PDFName.of('Text'),
                        Rect:     tinyRect, 
                        Contents: PDFHexString.of(toUTF16BEHex(rep.text)),
                        T:        PDFHexString.of(toUTF16BEHex(repAuthorName)),
                        IRT:      annotRef, 
                        RT:       PDFName.of('R'),
                        M:        PDFString.of(`D:${dateStr}`),
                    });
                    pdfDoc2.context.assign(repRef, repDict);
                    annotsArr.push(repRef);
                }
            }
        }
        processed++;
        onProgress(20 + (processed / totalPagesWithData) * 70);
    }

    onProgress(95);
    return pdfDoc2.save();
}

async function drawSummaryPage(pdfDoc2, pub, fontR, fontB) {
    const { rgb } = getPDFLib();
    const gray1  = rgb(0.10, 0.13, 0.25);
    const gray2  = rgb(0.31, 0.36, 0.50);
    const blue   = rgb(0.23, 0.43, 0.97);
    const bgBlue = rgb(0.94, 0.96, 1.00);
    const purple = rgb(0.55, 0.36, 0.96);

    function sanitize(str) { 
        return (str || '').replace(/[^\x00-\xFF]/g, '?').replace(/[\r\n]+/g, ' '); 
    }

    let page = pdfDoc2.addPage([595, 842]);
    let sy = 778;

    const drawHeader = () => {
        page.drawRectangle({ x:0, y:802, width:595, height:40, color:bgBlue });
        page.drawText('Annotation Summary', { x:28, y:822, size:15, font:fontB, color:gray1 });
        page.drawText(`${sanitize(fileName)}  ·  ${new Date().toLocaleDateString()}  ·  ${pub.length} annotation(s)`, { x:28, y:808, size:7.5, font:fontR, color:gray2 });
        page.drawLine({ start:{x:0,y:802}, end:{x:595,y:802}, thickness:1.5, color:blue });
        sy = 778;
    };

    drawHeader();

    for (const a of pub) {
        if (sy < 80) { page = pdfDoc2.addPage([595, 842]); drawHeader(); } 
        
        const mainAuthor = a.createdBy ? a.createdBy.name : (a.author || 'Reviewer');
        
        page.drawText(`Page ${a.page || 1}  |  #${a.number}  ${sanitize(a.type)}`, { x:28, y:sy, size:10, font:fontB, color:gray1 });
        page.drawText(`by ${sanitize(mainAuthor)}`, { x:230, y:sy, size:9, font:fontR, color:blue });
        if (a.isImported) page.drawText('(imported)', { x:340, y:sy, size:8, font:fontR, color:purple });
        page.drawText(sanitize(a.date || a.createdAt), { x:430, y:sy, size:8, font:fontR, color:gray2 });
        sy -= 5;
        page.drawLine({ start:{x:28,y:sy}, end:{x:567,y:sy}, thickness:0.4, color:rgb(0.85,0.88,0.95) });
        sy -= 14;
        
        const words = sanitize(a.text).split(/\s+/);
        let line = '';
        for (const w of words) {
            if (!w) continue;
            const test = line ? line + ' ' + w : w;
            if (fontR.widthOfTextAtSize(test, 10) > 520) {
                if (sy < 60) { page = pdfDoc2.addPage([595, 842]); drawHeader(); }
                page.drawText(line, { x:28, y:sy, size:10, font:fontR, color:gray2 });
                sy -= 14; line = w;
            } else { line = test; }
        }
        if (line) { 
            if (sy < 60) { page = pdfDoc2.addPage([595, 842]); drawHeader(); }
            page.drawText(line, { x:28, y:sy, size:10, font:fontR, color:gray2 }); 
            sy -= 14; 
        }
        sy -= 10;
    }
}