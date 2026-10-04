(function(g){
 'use strict';
 Object.defineProperty(g,'HubReleasePolicy',{value:Object.freeze({previewOnly:true,baselineCommit:false,matrixCanary:false,sourceRecalculate:false}),writable:false,configurable:false});
 const mount=()=>{const heading=document.querySelector('#matching h2');if(!heading||document.querySelector('[data-shadow-preview-release]'))return;const note=document.createElement('p');note.dataset.shadowPreviewRelease='';note.className='shadow-lineage';note.textContent='기준본 검증 · 미리보기: 가격·재고와 내보내기는 기존 운영 기준을 사용합니다. 기준본 갱신은 아직 사용할 수 없습니다.';heading.after(note);};
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})(window);
