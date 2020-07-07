const ws = require("ws");
class wsc {
   open(url) {
      this.url = url;
      this.instance = new ws(this.url);
      this.instance.on("open", () => {
         this.onopen();
      });
      this.instance.on("message", (data, flags) => {
         this.number++;
         this.onmessage(data, flags);
      });
      this.instance.on("close", (e) => {
         if (e.code !== 1000) {
            this.reconnect(e);
         }
         this.onclose(e);
      });
      this.instance.on("error", (e) => {
         if (e.code === "ECONNREFUSED") {
            this.reconnect(e);
         } else {
            this.onerror(e);
         }
      });
   }
   send(data, option) {
      try {
         this.instance.send(data, option);
      } catch (e) {
         this.instance.emit("error", e);
      }
   }
   reconnect(e) {
      this.instance.removeAllListeners();
      let that = this;
      setTimeout(function () {
         that.open(that.url);
      }, 2500);
   }
}
module.exports = wsc;