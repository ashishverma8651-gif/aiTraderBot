//utils.js

export function keepAlive(url) {
  setInterval(() => {
    fetch(url).then(() => console.log("💓 Keep-alive ping sent")).catch(()=>{});
  }, 1000 * 60 * 4); // every 4 minutes
}