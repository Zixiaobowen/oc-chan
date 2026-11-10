import assert from 'node:assert/strict'
import { until } from './core.mjs'

export async function eventPagination(instance, signal) {
  const click = async expression => {
    const point = await until(() => instance.main.evaluate(`(()=>{
      const item=${expression};if(!item||item.getAttribute('aria-disabled')==='true')return null;
      item.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
      const r=item.getBoundingClientRect(),point={x:r.x+r.width/2,y:r.y+r.height/2};
      if(!r.width||!r.height||point.x<0||point.y<0||point.x>=innerWidth||point.y>=innerHeight)
        throw new Error('Event control outside viewport after scroll: '+JSON.stringify({point,rect:r.toJSON(),viewport:[innerWidth,innerHeight]}));
      return point;
    })()`), { timeout:15000, signal })
    await instance.main.clickAt(point.x,point.y)
  }
  await click(`[...document.querySelectorAll('.sidebar nav button')].find(item=>/^(事件|Events)$/.test(item.textContent.trim()))`)
  await click(`document.querySelector('[data-event-action="latest"]')`)
  const page = index => until(async () => {
    await instance.drain()
    return instance.main.evaluate(`(()=>{const text=document.querySelector('.event-counts')?.textContent??'';const ids=[...document.querySelectorAll('.event-list [data-event-id]')].map(item=>item.dataset.eventId);return new RegExp('第 ${index} 页|Page ${index}').test(text)&&ids.length?ids:null})()`)
  }, { timeout:15000, signal })
  const first = await page(1)
  await click(`document.querySelector('[data-event-action="next"]')`)
  const second = await page(2)
  assert(first.length<=50 && second.length<=50)
  assert.equal(new Set([...first,...second]).size,first.length+second.length)
  await instance.interact(0)
  return { first,second,distinct:true,scope:'real native WK input and rendered React event rows' }
}
