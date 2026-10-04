import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const appSource = fs.readFileSync(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../src/styles/picking.css", import.meta.url), "utf8");
const migration = fs.readFileSync(
  new URL("../supabase/image-project-migrations/20260812032000_allow_dashboard_sellpia_photo_upsert.sql", import.meta.url),
  "utf8",
);
const deleteMigration = fs.readFileSync(
  new URL("../supabase/image-project-migrations/20260903031502_allow_dashboard_sellpia_photo_delete.sql", import.meta.url),
  "utf8",
);

assert.match(html, /dashboard-tools-grid[\s\S]*?출력 · 정렬[\s\S]*?조회 · 관리[\s\S]*?상품 사진 관리/);
assert.match(html, /id="dashboard-photo-dropzone"[\s\S]*?여기에 상품 사진 여러 장을 드래그/);
assert.match(html, /id="dashboard-photo-input"[^>]*multiple/);
assert.match(html, /파일명은 셀피아 SKU/);
assert.match(html, /8601-\[1\]\[3\]\.jpg/);
assert.match(html, /8601-\[1-10\]\.jpg/);
assert.match(html, /\{8601\}\.jpg/);
assert.match(html, /\{8601-\[1-10\]\}\.jpg/);
assert.match(html, /data-dashboard-action="photo-upload-select"[^>]*>사진 여러 장 선택/);
assert.match(html, /id="dashboard-photo-search"/);
assert.match(html, /id="dashboard-photo-filter"/);
assert.match(html, /id="dashboard-photo-library-grid"/);
assert.match(html, /data-dashboard-action="photo-library-more"/);
assert.match(html, /사진 라이브러리[\s\S]*?이름 변경·삭제/);
assert.match(html, /dashboard-photo-library-scroll[\s\S]*?id="dashboard-photo-library-grid"[\s\S]*?data-dashboard-action="photo-library-more"/);
assert.match(css, /\.dashboard-photo-dropzone\.is-dragging/);
assert.match(css, /\.dashboard-photo-upload-status\.success/);
assert.match(css, /\.dashboard-photo-library-grid/);
assert.match(css, /\.dashboard-photo-library-item/);
assert.match(css, /\.dashboard-photo-library-item\.is-selected/);
assert.match(css, /\.dashboard-photo-library-select input/);
assert.match(css, /\.dashboard-photo-library-scroll[\s\S]*?height: clamp\(260px, 36vh, 390px\)[\s\S]*?overflow: auto/);
assert.match(css, /\.photo-library-context-menu[\s\S]*?position: fixed/);
assert.match(css, /\.photo-viewer-body[\s\S]*?overflow: auto/);
assert.match(css, /\.photo-viewer-zoom-control input/);

assert.match(appSource, /const IMAGE_SUPABASE_KEY = "sb_publishable_/);
assert.doesNotMatch(appSource, /service_role|sb_secret_/i, "frontend must not expose a Supabase secret key");
assert.match(appSource, /const PRODUCT_PHOTO_GROUP_SUFFIX = "\.__group"/);
assert.match(appSource, /const PRODUCT_PHOTO_RANGE_SUFFIX = "\.__range"/);
assert.match(appSource, /const PRODUCT_PHOTO_PRIORITY_SUFFIX = "\.__priority"/);
assert.match(appSource, /const storageSku = productPhotoStorageCode\(sku, targetTier, priority\)/);
assert.match(appSource, /const objectPath = `\$\{PRODUCT_PHOTO_FOLDER\}\/\$\{storageSku\}\.jpg`/);
assert.match(
  appSource,
  /imageDb\.storage\.from\(IMAGE_BUCKET\)\.upload\(objectPath, jpeg, \{[\s\S]*?contentType: "image\/jpeg"[\s\S]*?cacheControl: "0"[\s\S]*?upsert: true/,
);
assert.match(appSource, /canvas\.toBlob[\s\S]*?"image\/jpeg"/);
assert.match(appSource, /dashboardPhotoDropzone\?\.addEventListener\("drop"[\s\S]*?uploadProductPhotos\(event\.dataTransfer\?\.files\)/);
assert.match(appSource, /markProductPhotoUpdated\(storageSku\)/);
assert.match(appSource, /storage\.from\(IMAGE_BUCKET\)\.list\(PRODUCT_PHOTO_FOLDER/);
assert.match(appSource, /limit: pageSize[\s\S]*?offset: library\.offset[\s\S]*?sortBy: \{ column: "name", order: "asc" \}/);
assert.match(appSource, /button\.dataset\.dashboardAction === "photo-library-search"/);
assert.match(appSource, /button\.dataset\.dashboardAction === "photo-library-more"/);
assert.match(appSource, /data-photo-library-entry=/);
assert.match(appSource, /selectedNames: new Set\(\)/);
assert.match(appSource, /function ensureProductPhotoLibraryContextMenu\(\)/);
assert.match(appSource, /data-photo-library-context-action="rename"/);
assert.match(appSource, /data-photo-library-context-action="delete"/);
assert.match(appSource, /document\.addEventListener\("contextmenu", openProductPhotoLibraryContextMenuFromEvent, true\)/);
assert.match(appSource, /function openProductPhotoLibraryContextMenuFromEvent\(event\)/);
assert.match(appSource, /function selectedProductPhotoLibraryEntries\(\)/);
assert.match(appSource, /function deleteProductPhotoLibraryEntries\(entries\)/);
assert.match(appSource, /data-photo-library-select=/);
assert.match(appSource, /deleteSelected \? "delete-selected" : "delete"/);
assert.match(appSource, /선택 사진 \$\{selectedEntries\.length\}개 삭제/);
assert.match(appSource, /const PHOTO_VIEWER_ZOOM_STORAGE_KEY = "system-v3-photo-viewer-zoom"/);
assert.match(appSource, /function normalizePhotoViewerZoom\(value\)/);
assert.match(appSource, /function setPhotoViewerZoom\(value, \{ persist = true \} = \{\}\)/);
assert.match(appSource, /data-photo-action="zoom-apply"/);
assert.match(appSource, /window\.localStorage\.setItem\(PHOTO_VIEWER_ZOOM_STORAGE_KEY, String\(zoom\)\)/);
assert.doesNotMatch(appSource, /data-photo-library-action=/, "photo library cards must use the context menu, not inline action buttons");
assert.match(appSource, /function productPhotoRenameStorageCode\(entry, code\)/);
assert.match(appSource, /imageDb\.storage\.from\(IMAGE_BUCKET\)\.remove\(\[sourcePath\]\)/);
assert.match(appSource, /imageDb\.storage\.from\(IMAGE_BUCKET\)\.remove\(uniqueEntries\.map\(\(entry\) => `\$\{PRODUCT_PHOTO_FOLDER\}\/\$\{entry\.name\}`\)\)/);

const skuFunctionSource = appSource.slice(
  appSource.indexOf("function photoFileStem"),
  appSource.indexOf("\nfunction productPhotoFileAllowed"),
);
const { sellpiaSkuFromPhotoFileName, sellpiaSkuTargetsFromPhotoFileName, photoFileTargetTier, photoFileHasPriority } = new Function(`${skuFunctionSource}; return { sellpiaSkuFromPhotoFileName, sellpiaSkuTargetsFromPhotoFileName, photoFileTargetTier, photoFileHasPriority };`)();
assert.equal(sellpiaSkuFromPhotoFileName("8601-1.JPG"), "8601-1");
assert.equal(sellpiaSkuFromPhotoFileName("  10646-3.webp "), "10646-3");
assert.equal(sellpiaSkuFromPhotoFileName("folder/8601-1.jpg"), "");
assert.equal(sellpiaSkuFromPhotoFileName(".jpg"), "");
assert.deepEqual(sellpiaSkuTargetsFromPhotoFileName("8601.jpg"), ["8601"]);
assert.deepEqual(sellpiaSkuTargetsFromPhotoFileName("8601-[1][3][5].jpg"), ["8601-1", "8601-3", "8601-5"]);
assert.deepEqual(sellpiaSkuTargetsFromPhotoFileName("8601-[1-10].jpg"), ["8601-1", "8601-2", "8601-3", "8601-4", "8601-5", "8601-6", "8601-7", "8601-8", "8601-9", "8601-10"]);
assert.deepEqual(sellpiaSkuTargetsFromPhotoFileName("{8601-[1-3]}.jpg"), ["8601-1", "8601-2", "8601-3"]);
assert.deepEqual(sellpiaSkuTargetsFromPhotoFileName("{8601}.jpg"), ["8601"]);
assert.deepEqual(sellpiaSkuTargetsFromPhotoFileName("8601-[1,10].jpg"), []);
assert.deepEqual(sellpiaSkuTargetsFromPhotoFileName("8601-[10-1].jpg"), []);
assert.equal(photoFileTargetTier("8601.jpg"), "direct");
assert.equal(photoFileTargetTier("8601-[1][3].jpg"), "group");
assert.equal(photoFileTargetTier("8601-[1-3].jpg"), "range");
assert.equal(photoFileTargetTier("{8601-[1-3]}.jpg"), "range");
assert.equal(photoFileTargetTier("8601-[1][2-4].jpg"), "");
assert.equal(photoFileHasPriority("{8601}.jpg"), true);
assert.equal(photoFileHasPriority("8601.jpg"), false);

const imageFunctionSource = appSource.slice(
  appSource.indexOf("function productImageUrlForCode"),
  appSource.indexOf("\nfunction photoFileStem"),
);
const { productImageUrl, productImageFallbackUrls } = new Function(
  "IMAGE_SUPABASE_URL",
  "IMAGE_BUCKET",
  "PRODUCT_PHOTO_FOLDER",
  "PRODUCT_PHOTO_GROUP_SUFFIX",
  "PRODUCT_PHOTO_RANGE_SUFFIX",
  "PRODUCT_PHOTO_PRIORITY_SUFFIX",
  "productPhotoVersion",
  `${imageFunctionSource}; return { productImageUrl, productImageFallbackUrls };`,
)("https://test.supabase.co", "product-images", "sellpia", ".__group", ".__range", ".__priority", () => "");
assert.equal(productImageUrl("8601-2"), "https://test.supabase.co/storage/v1/object/public/product-images/sellpia/8601-2.__priority.jpg");
assert.deepEqual(productImageFallbackUrls("8601-2"), [
  "https://test.supabase.co/storage/v1/object/public/product-images/sellpia/8601-2.__group.__priority.jpg",
  "https://test.supabase.co/storage/v1/object/public/product-images/sellpia/8601-2.__range.__priority.jpg",
  "https://test.supabase.co/storage/v1/object/public/product-images/sellpia/8601.__priority.jpg",
  "https://test.supabase.co/storage/v1/object/public/product-images/sellpia/8601-2.jpg",
  "https://test.supabase.co/storage/v1/object/public/product-images/sellpia/8601-2.__group.jpg",
  "https://test.supabase.co/storage/v1/object/public/product-images/sellpia/8601-2.__range.jpg",
  "https://test.supabase.co/storage/v1/object/public/product-images/sellpia/8601.jpg",
]);
assert.deepEqual(productImageFallbackUrls("8601"), ["https://test.supabase.co/storage/v1/object/public/product-images/sellpia/8601.jpg"]);
assert.match(appSource, /data-photo-fallbacks/);

const libraryFunctionSource = appSource.slice(
  appSource.indexOf("function productPhotoLibraryEntry"),
  appSource.indexOf("\nfunction photoTitleForItem"),
);
const { productPhotoLibraryEntry } = new Function(
  "PRODUCT_PHOTO_GROUP_SUFFIX",
  "PRODUCT_PHOTO_RANGE_SUFFIX",
  "PRODUCT_PHOTO_PRIORITY_SUFFIX",
  `${libraryFunctionSource}; return { productPhotoLibraryEntry };`,
)(".__group", ".__range", ".__priority");
assert.equal(productPhotoLibraryEntry({ name: "8601-2.jpg" }).type, "direct");
assert.equal(productPhotoLibraryEntry({ name: "8601-2.__group.jpg" }).type, "group");
assert.equal(productPhotoLibraryEntry({ name: "8601-2.__range.jpg" }).type, "range");
assert.equal(productPhotoLibraryEntry({ name: "8601.jpg" }).type, "common");
assert.equal(productPhotoLibraryEntry({ name: "8601-2.__range.__priority.jpg" }).priority, true);
assert.equal(productPhotoLibraryEntry({ name: "folder/8601.jpg" }), null);

assert.match(migration, /for insert[\s\S]*?to anon, authenticated[\s\S]*?bucket_id = 'product-images'/);
assert.match(migration, /for update[\s\S]*?using[\s\S]*?with check/);
assert.match(migration, /name ~ '\^sellpia\/\[\^\/\]\+\[\.\]jpg\$'/);
assert.match(deleteMigration, /for delete[\s\S]*?to anon, authenticated[\s\S]*?bucket_id = 'product-images'/);
assert.match(deleteMigration, /name ~ '\^sellpia\/\[\^\/\]\+\[\.\]jpg\$'/);

console.log("Dashboard photo library upload, rename, delete policy, and cache refresh: passed");
