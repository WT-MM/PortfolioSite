var _ = require("response.js")
Response.create({ mode: 'markup', prefix: 'r', breakpoints: [0,320,481,641,961,1020,1281] });
Response.create({ mode: 'src',  prefix: 'src', breakpoints: [0,320,481,641,961,1020,1281] });
console.log(Response.width)
console.log("Test")
alert("hi")