
// ═══════════════════════════════════════════════════════════════
// ⚙️ CONFIGURATION (Update these before Production Deployment)
// ═══════════════════════════════════════════════════════════════
const API_BASE_URL = 'http://localhost:8080/annotation-application'; // Change to Render URL in Prod 
const WS_BASE_URL  = 'ws://localhost:8080/annotation-application';   // Change to wss://api.myapp.com in Prod

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

// ── STATE VARIABLES ──
let currentUser      = 'nitish-test';
let currentUserId    = '007'; 
let currentUserEmail = 'test@tbits.com';
let currentDocumentId = 'DOC-test-123';

let nativeWs = null; 
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
let pageCanvasStates = {};
let deletedImportedSignatures = new Set();
let pageData = {};
let isFileLoaded = false;
let autoSaveTimer = null; // Used for smart debounced saving

// ═══════════════════════════════════════════════════════════════
// SECTION 1 — BOOTSTRAP & INITIALIZATION
// ═══════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
    
    // 1. Extract Document ID and User from URL (Fallback for local testing)
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('docId')) {
        currentDocumentId = urlParams.get('docId');
    }
    
    if (urlParams.has('user')) {
        currentUser = urlParams.get('user');
        currentUserId = currentUser.toLowerCase();
    } else {
        // Use standard Auth logic (JWT/Headers) if no URL params
        initializeUserIdentity(); 
    }

    console.log(`👤 Current User: ${currentUser} | 📄 Document: ${currentDocumentId}`);

    connectWebSocket();    
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

    renderList();

    // Small delay to ensure UI is fully mounted before loading data
    setTimeout(loadFromServer, 500);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2 — NATIVE WEBSOCKET CONNECTION
// ═══════════════════════════════════════════════════════════════
function connectWebSocket() {
    const wsUrl = `${WS_BASE_URL}/ws-annotator/${currentDocumentId}`;
    nativeWs = new WebSocket(wsUrl);

    nativeWs.onopen = function () {
        console.log(`✅ Connected to WebSocket: ${wsUrl}`);
    };

    nativeWs.onmessage = function (event) {
        const receivedData = JSON.parse(event.data);
        
        // Ignore self-broadcasts
        if (receivedData.sender !== currentUser) {
            console.log("📥 Incoming update from: " + receivedData.sender);

            if (receivedData.action === 'ADD' || receivedData.action === 'UPDATE') {
                const incomingAnno = receivedData.shapeData.annotation;
                const incomingFabricJson = receivedData.shapeData.fabricShape;
                
                // Update State
                const existingIndex = annotations.findIndex(a => a.id === incomingAnno.id);
                if (existingIndex > -1) {
                    annotations[existingIndex] = incomingAnno;
                } else {
                    annotations.push(incomingAnno);
                }
                
                annoCounter = Math.max(annoCounter, (incomingAnno.number || 0) + 1);

                // Update Canvas
                if (incomingFabricJson) {
                    fabric.util.enlivenObjects([incomingFabricJson], function(objects) {
                        const newObj = objects[0];
                        const existingObj = canvas.getObjects().find(o => o.id === newObj.id);
                        if (existingObj) canvas.remove(existingObj); // Remove old shape if updating
                        
                        canvas.add(newObj);
                        canvas.renderAll();
                        renderBadges();
                        renderList(); 
                        updateJsonState(); 
                        toast(`Update from ${receivedData.sender}`, '✨');
                    });
                }
            }
        }
    };

    nativeWs.onclose = function () {
        console.warn('❌ WebSocket Connection Lost. Reconnecting in 5 seconds...');
        if (!nativeWs._manualClose) {
            setTimeout(connectWebSocket, 5000);
        }
    };

    nativeWs.onerror = function (error) {
        console.error('❌ WebSocket Error:', error);
    };
}

function broadcastAnnotationChange(action, annoObj) {
    if (!nativeWs || nativeWs.readyState !== 1) return;

    const fabricObj = canvas.getObjects().find(o => o.id === annoObj.id);
    let fabricJson = null;
    if (fabricObj) {
        fabricJson = fabricObj.toJSON(['id', 'transparentCorners', 'cornerColor', 'cornerSize', 'borderColor']);
    }

    const messagePayload = {
        documentId: currentDocumentId,
        action: action,
        sender: currentUser,
        shapeData: { annotation: annoObj, fabricShape: fabricJson }
    };
    nativeWs.send(JSON.stringify(messagePayload));
}

// ═══════════════════════════════════════════════════════════════
// SECTION 3 — SMART AUTO-SAVE (Event Driven)
// ═══════════════════════════════════════════════════════════════
// This prevents spamming the server. It waits 1 second after user stops acting.
function triggerAutoSave() {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
        handleSaveToServer();
    }, 1000); 
}

// ═══════════════════════════════════════════════════════════════
// SECTION 4 — SERVER COMMUNICATION (SAVE/LOAD APIs)
// ═══════════════════════════════════════════════════════════════
// async function handleSaveToServer() {
//     // ⚠️ DO NOT discardActiveObject() here! It ruins UX during auto-save.
    
//     // Temporarily remove background to save JSON payload size
//     const bgImage = canvas.backgroundImage;
//     canvas.backgroundImage = null;
    
//     const fullState = {
//         annotations: annotations,
//         annoCounter: annoCounter,
//         canvasData: canvas.toJSON(['id', 'transparentCorners', 'cornerColor', 'cornerSize', 'borderColor'])
//     };
    
//     // Restore background immediately
//     canvas.backgroundImage = bgImage;
//     canvas.renderAll();
    
//     const SERVER_URL = `${API_BASE_URL}/api/annotations/save/${currentDocumentId}`;
    
//     try {
//         const response = await fetch(SERVER_URL, {
//             method: 'POST',
//             headers: { 'Content-Type': 'application/json' },
//             body: JSON.stringify(fullState)
//         });
        
//         if (response.ok) {
//             console.log("☁ Auto-saved to database");
//         } else {
//             console.error(`Server error ${response.status}`);
//         }
//     } catch (err) {
//         console.error('Save failed: ' + err.message);
//     }
// }

async function handleSaveToServer() {
    // DO NOT discardActiveObject() here! It ruins UX during auto-save.
    
    // Temporarily remove background to save JSON payload size
    const bgImage = canvas.backgroundImage;
    canvas.backgroundImage = null;
    
    //MULTI-PAGE FIX STEP 1: Current page  forcefully insert in memory 
    if (typeof pageCanvasStates !== 'undefined' && canvas) {
        pageCanvasStates[pageNum] = canvas.toJSON(['id', 'transparentCorners', 'cornerColor', 'cornerSize', 'borderColor']);
    }

    //MULTI-PAGE FIX STEP 2: get annotation coordinates from  memory 
    annotations.forEach(a => {
        let targetPage = a.page || 1;
        // Memory me se us page ka data nikalo
        let pageData = pageCanvasStates[targetPage]; 
        
        if (pageData && pageData.objects) {
            // Us page par yeh wala box/shape dhoondo
            let shape = pageData.objects.find(o => o.id === a.id);
            if (shape) {
                // Mil gaya! Ab uske coordinates annotation object mein chipka do
                a.left = shape.left;
                a.top = shape.top;
                a.width = shape.width;
                a.height = shape.height;
                a.scaleX = shape.scaleX || 1;
                a.scaleY = shape.scaleY || 1;
            }
        }
    });
    
    const fullState = {
        annotations: annotations, // ✅ Ab isme har page ke coordinates hain!
        annoCounter: annoCounter,
        // Hum poori memory DB ko bhej rahe hain taaki next time saare pages load ho sakein
        canvasData: canvas.toJSON(['id', 'transparentCorners', 'cornerColor', 'cornerSize', 'borderColor']),
        pageStates: typeof pageCanvasStates !== 'undefined' ? pageCanvasStates : {} 
    };
    
    // Restore background immediately
    canvas.backgroundImage = bgImage;
    canvas.renderAll();
    
    const SERVER_URL = `${API_BASE_URL}/api/annotations/save/${currentDocumentId}`;
    
    try {
        const response = await fetch(SERVER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fullState)
        });
        
        if (response.ok) {
            console.log("☁ Auto-saved to database");
        } else {
            console.error(`Server error ${response.status}`);
        }
    } catch (err) {
        console.error('Save failed: ' + err.message);
    }
}

// async function loadFromServer() {
//     const FILE_URL = `${API_BASE_URL}/api/annotations/file/${currentDocumentId}`;
//     const JSON_URL = `${API_BASE_URL}/api/annotations/load/${currentDocumentId}`;

//     try {
//         // STEP 1: Fetch Original File
//         const fileResponse = await fetch(FILE_URL);
//         if (fileResponse.ok) {
//             const blob = await fileResponse.blob();
//             const file = new File([blob], `${currentDocumentId}.pdf`, { type: 'application/pdf' });

//             await processFile(file); 

//             isFileLoaded = true;
//             document.getElementById('empty-state').style.display = 'none';
//             document.getElementById('scroll-container').style.display = 'block';
//         }

//         // STEP 2: Fetch JSON Metadata (Delay mapping by 1 sec to avoid race conditions with PDF renderer)
//         const jsonResponse = await fetch(JSON_URL);
//         const data = await jsonResponse.json();

//         setTimeout(() => {
//             if (data && data.canvasData && data.canvasData.objects) {
//                 annotations = data.annotations || [];
//                 annoCounter = data.annoCounter || 1;

//                 fabric.util.enlivenObjects(data.canvasData.objects, function(objects) {
//                     objects.forEach(function(obj) {
//                         canvas.add(obj); 
//                     });
//                     canvas.renderAll();
//                     renderBadges();
//                     renderList();
//                     updateJsonState();
//                     toast('Annotations mapped on PDF!', '📥');
//                 });
//             }
//         }, 1000); 
//     } catch (err) {
//         console.error("Error loading data:", err);
//     }
// }
async function loadFromServer() {
    const FILE_URL = `${API_BASE_URL}/api/annotations/file/${currentDocumentId}`;
    const JSON_URL = `${API_BASE_URL}/api/annotations/load/${currentDocumentId}`;

    try {
        // STEP 1: Fetch Original File
        const fileResponse = await fetch(FILE_URL);
        if (fileResponse.ok) {
            const blob = await fileResponse.blob();
            const file = new File([blob], `${currentDocumentId}.pdf`, { type: 'application/pdf' });

            await processFile(file); 

            isFileLoaded = true;
            document.getElementById('empty-state').style.display = 'none';
            document.getElementById('scroll-container').style.display = 'block';
        }

        // STEP 2: Fetch JSON Metadata
        const jsonResponse = await fetch(JSON_URL);
        const data = await jsonResponse.json();

        setTimeout(() => {
            if (data) {
                // 1. Comments aur counter load karo
                annotations = data.annotations || [];
                annoCounter = data.annoCounter || 1;

                // 🚀 CRITICAL FIX 1: Server se Memory (pageStates) wapas JS mein load karo
                if (data.pageStates) {
                    pageCanvasStates = data.pageStates;
                    
                    // 🚀 CRITICAL FIX 2: Download/Summary features ke liye pageData ko bhi zinda karo
                    for (const [pStr, pState] of Object.entries(pageCanvasStates)) {
                        pageData[pStr] = {
                            annotations: annotations.filter(a => a.page === parseInt(pStr)),
                            annoCounter: annoCounter,
                            canvasData: pState
                        };
                    }
                } else if (data.canvasData) {
                    // Agar koi purani DB entry hai jisme pageStates nahi tha, toh usko page 1 maan lo
                    pageCanvasStates[1] = data.canvasData;
                }

                // 2. Current Page (default Page 1) ki drawing ko Canvas par draw karo
                const currentPageState = pageCanvasStates[pageNum];
                
                if (currentPageState && currentPageState.objects && currentPageState.objects.length > 0) {
                    // fabric.util.enlivenObjects(currentPageState.objects, function(objects) {
                    //     // Naye objects dalne se pehle canvas saaf karo taki duplicate na banein
                    //     canvas.getObjects().forEach(obj => {
                    //         if (!obj.isType('image')) canvas.remove(obj); 
                    //     });
                        
                    
                      fabric.util.enlivenObjects(currentPageState.objects, function(objects) {
                        
                        // 🚀 BUG FIX: Purane boxes ko sahi tareeqe se hatana (Taki old annotations fass na jayein)
                        const objectsToRemove = canvas.getObjects().filter(obj => obj.type !== 'image');
                        objectsToRemove.forEach(obj => canvas.remove(obj));
                        
                        // Objects add karo
                        objects.forEach(function(obj) {
                            canvas.add(obj); 
                        });
                        
                        canvas.renderAll();
                        renderBadges();
                        renderList();
                        updateJsonState();
                
                        toast('Annotations mapped on PDF!', '📥');
                    });
                } else {
                    // Agar page 1 par kuch draw nahi hai, toh bas UI render kardo
                    renderList();
                    renderBadges();
                    updateJsonState();
                }
            }
        }, 1000); 
    } catch (err) {
        console.error("Error loading data:", err);
    }
}

// ═══════════════════════════════════════════════════════════════
// SECTION 5 — USER IDENTITY
// ═══════════════════════════════════════════════════════════════
// function initializeUserIdentity() {
//     const token = localStorage.getItem('app_token'); 
    
//     if (token) {
//         try {
//             const payload = JSON.parse(atob(token.split('.')[1])); 
//             currentUser      = payload.name || payload.fullName || 'Reviewer';
//             currentUserId    = payload.sub || payload.userId || 'guest';
//             currentUserEmail = payload.email || '';
//             return; 
//         } catch (error) {
//             console.warn('⚠️ Invalid JWT Token, falling back...');
//         }
//     }

//     const headerUserNameElement = document.getElementById('header-user-name');
//     if (headerUserNameElement && headerUserNameElement.innerText) {
//         currentUser = headerUserNameElement.innerText.trim();
//         const headerUserIdElement = document.getElementById('header-user-id');
//         currentUserId = headerUserIdElement ? headerUserIdElement.innerText.trim() : currentUser.toLowerCase().replace(/\s+/g, '_');
//         return;
//     }
//     console.log('⚠️ No identity found. Defaulting to Guest.');
// }
function initializeUserIdentity() {

    currentUser = "Guest";
    currentUserId = "guest";
    currentUserEmail = "";

    // 1️. JWT token stored in localStorage
    const token = localStorage.getItem("app_token");

    if (token) {
        try {
            const payload = JSON.parse(atob(token.split(".")[1]));

            currentUser =
                payload.name ||
                payload.preferred_username ||
                payload.fullName ||
                "Reviewer";

            currentUserId =
                payload.sub ||
                payload.userId ||
                payload.username ||
                "guest";

            currentUserEmail = payload.email || "";

            console.log("✅ Identity from JWT");
            return;

        } catch (e) {
            console.warn("⚠️ Invalid JWT");
        }
    }

    // 2. OIDC client session (oidc-client / oidc-client-ts)
    if (window.oidcUser && window.oidcUser.profile) {

        const profile = window.oidcUser.profile;

        currentUser =
            profile.name ||
            profile.preferred_username ||
            "Reviewer";

        currentUserId =
            profile.sub ||
            profile.username ||
            "guest";

        currentUserEmail = profile.email || "";

        console.log("✅ Identity from OIDC session");
        return;
    }

    // 3️. Security rendered header
    const nameElement = document.getElementById("header-user-name");

    if (nameElement && nameElement.innerText) {

        currentUser = nameElement.innerText.trim();

        const idElement = document.getElementById("header-user-id");

        currentUserId = idElement
            ? idElement.innerText.trim()
            : currentUser.toLowerCase().replace(/\s+/g, "_");

        console.log("✅ Identity from HTML header");
        return;
    }

    // 4️⃣ Final fallback
    console.warn("⚠️ No identity found → Guest");
}
// ═══════════════════════════════════════════════════════════════
// SECTION 6 — FILE LOADING & PDF ENGINE
// ═══════════════════════════════════════════════════════════════
function resetState() {
    annotations  = [];
    annoCounter  = 1;
    activeAnnoId = null;
    
    if (canvas) { canvas.clear(); canvas.setZoom(1); }
    currentZoom = 1;

    pdfDoc = null; pageNum = 1; totalPages = 1; originalPdfBytes = null; fileType = 'image';
    deletedImportedSignatures.clear(); pageData = {};

    hideCommentInput(); showNoSel(); updateToolbarState(false);
    renderList(); renderBadges(); updateJsonState();

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
// SECTION 7 — DRAWING & TOOLS
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
    
    // Auto-save triggers on modification
    // canvas.on('object:modified', () => triggerAutoSave());
    // Auto-save AND Live Broadcast triggers on modification (Move/Resize)
    canvas.on('object:modified', (e) => {
        triggerAutoSave();
        
        // 🚀 NEW FIX 2: if any one  move box ,then live sync 
        if (e.target && e.target.id) {
            const modifiedAnno = annotations.find(a => a.id === e.target.id);
            if (modifiedAnno) {
                broadcastAnnotationChange('UPDATE', modifiedAnno);
            }
        }
    });
}

function finalizeAnno(obj, type) {
    activateTool('select');
    const id = 'anno-' + Date.now();
    obj.id = id;
    const now = new Date().toISOString();
    
    // annotations.push({
    //     id, number: annoCounter++, 
    //     type: TYPE_LABELS[type] || type,
    //     date: new Date().toLocaleString(),
    //     text: '', isDraft: true, color: currentColor, fabricType: type,
    annotations.push({
        id, number: annoCounter++, 
        type: TYPE_LABELS[type] || type,
        page: pageNum, // 🚀 FIX 1: JSON ko ab pata chalega comment kis page ka hai
        date: new Date().toLocaleString(),
        text: '', isDraft: true, color: currentColor, fabricType: type,
        isImported: false,
        createdBy: { id: currentUserId, name: currentUser, email: currentUserEmail },
        createdAt: now,
        lastEditedBy: null, lastEditedAt: null, editHistory: [], replies: [] 
    });
    canvas.setActiveObject(obj);
    showCommentInput(id, true);
    updateJsonState();
    triggerAutoSave();


    const newAnno = {
        id, number: annoCounter++, 
        type: TYPE_LABELS[type] || type,
        page: pageNum, 
        date: new Date().toLocaleString(),
        isDraft: true,
        text: '', isDraft: true, color: currentColor, fabricType: type,
        isImported: false,
        createdBy: { id: currentUserId, name: currentUser, email: currentUserEmail },
        createdAt: now,
        lastEditedBy: null, lastEditedAt: null, editHistory: [], replies: [] 
    };
    annotations.push(newAnno);
   
    // 🚀 NEW FIX 1: Jaise hi mouse chhode, turant drawing doosri screen par bhej do!
    broadcastAnnotationChange('ADD', newAnno);
}

// ═══════════════════════════════════════════════════════════════
// SECTION 8 — COMMENTS & CRUD
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
        pin.className = 'anno-badge' + (a.id === activeAnnoId ? ' active-badge' : '') + (a.isImported ? ' imported-badge' : '');
        pin.style.left       = (px - 8) + 'px';
        pin.style.top        = (py - 8) + 'px';
        pin.style.background = a.isImported ? `linear-gradient(135deg, ${a.color}, #8b5cf6)` : a.color;
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

    if (anno) broadcastAnnotationChange('ADD', anno);
    triggerAutoSave();
}

window.editComment = id => {
    const obj = canvas.getObjects().find(o => o.id === id);
    if (obj) { canvas.setActiveObject(obj); canvas.renderAll(); }
    showCommentInput(id, false);
};

// window.deleteComment = id => {
//     const obj = canvas.getObjects().find(o => o.id === id);
//     if (obj) canvas.remove(obj);
//     annotations = annotations.filter(a => a.id !== id);
//     canvas.renderAll(); renderList(); renderBadges(); updateJsonState();
//     toast('Deleted', '🗑');
//     triggerAutoSave(); // Automatically sync deletion to DB
// };

// window.deleteActiveObject = function () {
//     const obj = canvas.getActiveObject(); if (!obj) return;
//     canvas.remove(obj);
//     annotations = annotations.filter(a => a.id !== obj.id);
//     hideCtx(); hideCommentInput(); renderList(); renderBadges(); canvas.renderAll();
//     updateJsonState();
//     toast('Annotation deleted', '🗑');
//     triggerAutoSave(); // Automatically sync deletion to DB
// };

window.deleteComment = id => {
    // 🚀 NEW FIX: Delete karne se pehle doosre users ko pipe ke zariye batao
    const annoToDelete = annotations.find(a => a.id === id);
    if (annoToDelete) {
        broadcastAnnotationChange('DELETE', annoToDelete);
    }

    const obj = canvas.getObjects().find(o => o.id === id);
    if (obj) canvas.remove(obj);
    annotations = annotations.filter(a => a.id !== id);
    canvas.renderAll(); renderList(); renderBadges(); updateJsonState();
    toast('Deleted', '🗑');
    triggerAutoSave(); // Automatically sync deletion to DB
};

window.deleteActiveObject = function () {
    const obj = canvas.getActiveObject(); if (!obj) return;
    
    // 🚀 NEW FIX: Keyboard se delete (Backspace/Delete) karne par bhi doosro ko batao
    const annoToDelete = annotations.find(a => a.id === obj.id);
    if (annoToDelete) {
        broadcastAnnotationChange('DELETE', annoToDelete);
    }

    canvas.remove(obj);
    annotations = annotations.filter(a => a.id !== obj.id);
    hideCtx(); hideCommentInput(); renderList(); renderBadges(); canvas.renderAll();
    updateJsonState();
    toast('Annotation deleted', '🗑');
    triggerAutoSave(); 
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
            createdBy: { id: currentUserId, name: currentUser, email: currentUserEmail },
            createdAt: new Date().toISOString(),
            date: new Date().toLocaleString(),
            text: text,
            isImported: false
        });
        
        input.value = ''; 
        renderList(); updateJsonState();
        toast('Reply added', '💬');
        triggerAutoSave();
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

        const originTag = a.isImported ? `<span class="cc-origin-tag imported">📥 Imported</span>` : `<span class="cc-origin-tag new">✏ New</span>`;

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
// SECTION 9 — UTILITIES (Zoom, Menus, Properties)
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
        if (anno) { anno.color = color; renderBadges(); triggerAutoSave(); }
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
        if (obj) { obj.set('opacity', v / 100); canvas.renderAll(); triggerAutoSave(); }
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
        triggerAutoSave();
    });
}

function setupZoom() {
    document.getElementById('canvas-wrapper').addEventListener('wheel', e => {
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); e.deltaY < 0 ? zoomIn() : zoomOut(); }
    }, { passive: false });
}
function zoomIn()    { currentZoom = Math.min(currentZoom + 0.15, 4);   applyZoom(); }
function zoomOut()   { currentZoom = Math.max(currentZoom - 0.15, 0.2); applyZoom(); }
function applyZoom() {
    canvas.setZoom(currentZoom);
    const baseW = canvas.backgroundImage ? canvas.backgroundImage.width  : 800;
    const baseH = canvas.backgroundImage ? canvas.backgroundImage.height : 600;
    const zW = Math.round(baseW * currentZoom);
    const zH = Math.round(baseH * currentZoom);
    canvas.setWidth(zW); canvas.setHeight(zH);
    const shadow = document.getElementById('canvas-shadow');
    shadow.style.width  = zW + 'px'; shadow.style.height = zH + 'px';
    document.getElementById('zoom-level').textContent = Math.round(currentZoom * 100) + '%';
    renderBadges();
}

function setupKeyboard() {
    const KEYS = { v:'select', p:'draw', r:'rect', e:'circle', a:'arrow', t:'text', l:'line' };
    document.addEventListener('keydown', e => {
        if (['TEXTAREA','INPUT'].includes(e.target.tagName)) return;
        if (KEYS[e.key.toLowerCase()])                   { activateTool(KEYS[e.key.toLowerCase()]); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { if (canvas.getActiveObject()) deleteActiveObject(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key === 'z')  { undoLast(); }
    });
}

function undoLast() {
    const objs = canvas.getObjects(); if (!objs.length) return;
    const last = objs[objs.length - 1];
    if (last.id) { annotations = annotations.filter(a => a.id !== last.id); renderList(); renderBadges(); updateJsonState(); }
    canvas.remove(last); canvas.renderAll();
    toast('Undone', '↩');
    triggerAutoSave();
}

function toast(msg, icon = '✅', dur = 2500) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span>${icon}</span><span>${escapeHTML(msg)}</span>`;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 200); }, dur);
}

function checkFileLoaded() {
    if (!isFileLoaded) { toast('Please open a document first!', '⚠️'); return false; }
    return true;
}

function setupButtons() {
    // Only used manual buttons (Export/Download PDF)
    document.getElementById('btn-download').addEventListener('click', () => {
        if (checkFileLoaded()) toast('PDF Export is a Work In Progress', '🚧');
    });
    
    document.getElementById('btn-save-server').addEventListener('click', () => {
        if (checkFileLoaded()) handleSaveToServer();
    });
}

function updateJsonState() {
    let totalAnnots = annotations.filter(a => !a.isDraft).length;
    const jsCount = document.getElementById('st-json-count');
    if (jsCount) jsCount.textContent = `{ } ${totalAnnots} annotation${totalAnnots !== 1 ? 's' : ''}`;
}

// ═══════════════════════════════════════════════════════════════
// PROGRESS BAR UI FUNCTIONS (Restored)
// ═══════════════════════════════════════════════════════════════
function showProgress(v, title = 'Processing…', sub = 'Please wait') {
    const wrap = document.getElementById('progress-bar-wrap');
    if (!wrap) return; 
    wrap.style.display = v ? 'flex' : 'none';
    
    const titleEl = document.getElementById('progress-title');
    if (titleEl) titleEl.textContent = title;
    
    const subEl = document.getElementById('progress-sub');
    if (subEl) subEl.textContent = sub;
    
    if (!v) {
        const fillEl = document.getElementById('progress-fill');
        if (fillEl) fillEl.style.width = '0%';
    }
}

function setProgress(pct) { 
    const fillEl = document.getElementById('progress-fill');
    if (fillEl) fillEl.style.width = pct + '%'; 
}
// ═══════════════════════════════════════════════════════════════
// SECTION 9 — BUTTON WIRING & JSON PREVIEW
// ═══════════════════════════════════════════════════════════════
function checkFileLoaded() {
    if (!isFileLoaded) { toast('Please open a document first!', '⚠️'); return false; }
    return true;
}

function setupButtons() {

document.getElementById('btn-prev').addEventListener('click', () => {
    if (pageNum > 1) {
        changePageAndPreserveState(pageNum - 1);
    }
});

document.getElementById('btn-next').addEventListener('click', () => {
    if (pdfDoc && pageNum < pdfDoc.numPages) {
        changePageAndPreserveState(pageNum + 1);
    }
});

    // 1. Download Annotated PDF
    document.getElementById('btn-download').addEventListener('click', () => {
        if (checkFileLoaded()) handleDownload();
    });
    
    // 2. Manual Save to Server
    document.getElementById('btn-save-server').addEventListener('click', () => {
        if (checkFileLoaded()) handleSaveToServer();
    });
    
    // 3. Export Summary PDF
    document.getElementById('btn-export-summary').addEventListener('click', () => {
        if (checkFileLoaded()) handleSummary();
    });

    // 4. View JSON in UI Panel
    const viewJsonBtn = document.getElementById('btn-view-json');
    if (viewJsonBtn) {
        viewJsonBtn.addEventListener('click', () => {
            if (!checkFileLoaded()) return;
            syncCurrentPage(); 
            const jsonData = getAnnotationsJSON();
            showJsonPreview(jsonData); 
        });
    }

    // 5. Download JSON File
    const dwnJsonBtn = document.getElementById('btn-download-json');
    if (dwnJsonBtn) {
        dwnJsonBtn.addEventListener('click', () => {
            if (!checkFileLoaded()) return;
            syncCurrentPage();
            const jsonData = getAnnotationsJSON();
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(jsonData, null, 2));
            const downloadAnchorNode = document.createElement('a');
            downloadAnchorNode.setAttribute("href", dataStr);
            downloadAnchorNode.setAttribute("download", fileName + "_annotations.json");
            document.body.appendChild(downloadAnchorNode); 
            downloadAnchorNode.click();
            downloadAnchorNode.remove();
            toast('JSON file downloaded!', '📄');
        });
    }
}
// 3. The Master Page Change Function
async function changePageAndPreserveState(newPageNum) {
    
    // ==========================================
    // STEP A: SAVE CURRENT PAGE DRAWINGS
    // ==========================================
    // if (canvas) {
    if (canvas) {
        syncCurrentPage();
        // PDF Background ko temporarily hatao taaki wo JSON mein save na ho jaye
        const tempBg = canvas.backgroundImage;
        canvas.backgroundImage = null; 
        
        // Sirf boxes/arrows/comments save karo
        pageCanvasStates[pageNum] = canvas.toJSON(['id', 'transparentCorners', 'cornerColor', 'borderColor']); 
        
        // Background wapas laga do (Just in case)
        canvas.backgroundImage = tempBg; 
    }

    // ==========================================
    // STEP B: UPDATE UI & PAGE NUMBER
    // ==========================================
    pageNum = newPageNum;
    const label = document.getElementById('page-label');
    if (label) label.textContent = `${pageNum} / ${pdfDoc.numPages}`;

    // ==========================================
    // STEP C: RENDER NEW PDF PAGE
    // ==========================================
    // ⚠️ IMPORTANT: Yahan aapke PDF render karne wale function ka naam aayega. 
    // Agar aapne uska naam renderPage rakha hai, toh wahi use karein.
    await renderPdfPage(pageNum); 

    // ==========================================
    // STEP D: RESTORE NEW PAGE DRAWINGS
    // ==========================================
    if (pageCanvasStates[pageNum]) {
        // Naye PDF page ka background safe rakh lo
        const newPdfBackground = canvas.backgroundImage;

        // Is page ki purani drawing load karo
        canvas.loadFromJSON(pageCanvasStates[pageNum], () => {
            // Drawing load hone ke baad naya background wapas set kar do
            canvas.backgroundImage = newPdfBackground;
            canvas.renderAll();
        });
    } else {
        // Agar naye page par kuch draw nahi hua tha, toh pichle page ke boxes hata do
        // Note: canvas.clear() mat use karna varna PDF udd jayega!
        const objects = canvas.getObjects();
        objects.forEach(obj => canvas.remove(obj));
        canvas.renderAll();
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

function getAnnotationsJSON() {
    syncCurrentPage();
    let allPub = [];
    // for (const [pStr, data] of Object.entries(pageData)) {
    //     const pubs = data.annotations.filter(a => !a.isDraft);
    for (const [pStr, data] of Object.entries(pageData)) {
        // 🚀 FIX 3: Sirf current page ke comments filter karo, warna API crash hogi ya duplicate aayenge
        const pubs = data.annotations.filter(a => !a.isDraft && (a.page || 1) === parseInt(pStr));
        pubs.forEach(a => {
            const objData = data.canvasData.objects.find(o => o.id === a.id);
            allPub.push({
                id: a.id, number: a.number, type: a.type, color: a.color,
                page: parseInt(pStr), isImported: a.isImported || false,
                createdBy: a.createdBy || { name: a.author || 'Unknown' },
                createdAt: a.createdAt || new Date().toISOString(),
                lastEditedBy: a.lastEditedBy || null,
                lastEditedAt: a.lastEditedAt || null,
                editHistory: a.editHistory || [],
                text: a.text, replies: a.replies || [],
                bbox: objData ? {
                    x: Math.round(objData.left),
                    y: Math.round(objData.top),
                    width: Math.round((objData.width || 0) * (objData.scaleX || 1)),
                    height: Math.round((objData.height || 0) * (objData.scaleY || 1))
                } : null
            });
        });
    }

    return {
        documentId: currentDocumentId,
        documentName: fileName,
        exportedAt: new Date().toISOString(),
        reviewer: { id: currentUserId, name: currentUser },
        totalPages,
        currentPage: pageNum,
        annotations: allPub
    };
}

function updateJsonState() {
    let totalAnnots = annotations.filter(a => !a.isDraft).length;
    for (const [pStr, data] of Object.entries(pageData)) {
        if (parseInt(pStr) !== pageNum) {
            totalAnnots += data.annotations.filter(a => !a.isDraft).length;
        }
    }
    const jsCount = document.getElementById('st-json-count');
    if (jsCount) jsCount.textContent = `{ } ${totalAnnots} annotation${totalAnnots !== 1 ? 's' : ''}`;
}

// ═══════════════════════════════════════════════════════════════
// SECTION 10 — PDF EXPORT & SUMMARY GENERATION
// ═══════════════════════════════════════════════════════════════
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

async function handleSummary() {
    syncCurrentPage();
    
    // let allPub = [];
    // for (const [pStr, data] of Object.entries(pageData)) {
    //     const pagePub = data.annotations.filter(a => !a.isDraft).map(a => ({...a, page: parseInt(pStr)}));
    //     allPub.push(...pagePub);
    // }
    let allPub = [];
    for (const [pStr, data] of Object.entries(pageData)) {
        // 🚀 FIX 4: Summary PDF mein saare pages ke comments mix hone se rokna
        const pagePub = data.annotations.filter(a => !a.isDraft && (a.page || 1) === parseInt(pStr)).map(a => ({...a, page: parseInt(pStr)}));
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

// Builds the final PDF using pdf-lib (Draws shapes and native PDF comments)
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
                        if (subtypeName === 'Text' || subtypeName === 'Popup') continue; 
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