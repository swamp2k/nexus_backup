import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexPath=new URL("../web/index.html",import.meta.url);

test("dashboard inline modules remain syntactically valid",async()=>{
  const html=await readFile(indexPath,"utf8");
  const modules=[...html.matchAll(/<script\s+type="module"\s*>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
  assert.ok(modules.length>=2,"expected device and transfer enhancement inline modules");
  modules.forEach((source,index)=>{
    assert.doesNotThrow(()=>new Function(source),`inline module ${index+1} should parse`);
  });
});

test("transfers enhancement does not create a MutationObserver feedback loop",async()=>{
  const html=await readFile(indexPath,"utf8");
  const modules=[...html.matchAll(/<script\s+type="module"\s*>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
  const source=modules.find(module=>module.includes("new MutationObserver(enhance)"));
  assert.ok(source,"expected the transfers enhancement module");

  let observerCallback;
  let noteWrites=0;
  const pendingMutations=[];
  const note={
    currentHtml:"",
    get innerHTML(){return this.currentHtml;},
    set innerHTML(value){
      noteWrites++;
      this.currentHtml=value;
      if(observerCallback)pendingMutations.push(()=>observerCallback([]));
    }
  };
  const document={
    querySelector:selector=>selector==="#transfers-view .transfer-note"?note:null,
    querySelectorAll:()=>[],
    addEventListener(){}
  };
  const window={fetch(){return Promise.resolve({});},addEventListener(){}};
  class MockMutationObserver{
    constructor(callback){observerCallback=callback;}
    observe(){}
  }

  new Function("window","document","MutationObserver","location","setInterval",source)(window,document,MockMutationObserver,{hash:""},()=>{});
  observerCallback([]);

  let rounds=0;
  while(pendingMutations.length&&rounds<10){
    rounds++;
    pendingMutations.splice(0).forEach(deliver=>deliver());
  }

  assert.equal(noteWrites,1,"rendering the safety note should cause only its initial DOM write");
  assert.equal(pendingMutations.length,0,"observer work should settle after rendering the note");
});
