let token = process.env.SPACE_TOKEN;
let environment = process.env.JB_SPACE_GIT_BRANCH === "refs/heads/dev" ? "lightquark-dev" : "lightquark";
console.log("Branch: ", process.env.JB_SPACE_GIT_BRANCH);
import axios from "axios";
/*import {exec} from "child_process";

// Get git branch
exec("git rev-parse --abbrev-ref HEAD", (error, stdout, stderr) => {
	environment = stdout.trim();
	console.log(`Environment: ${environment}`);
	environment = environment === "dev" ? "lightquark-dev" : "lightquark"*/
	console.log(`App name: ${environment}`);
	console.log(`Token: ${token}`)

	axios.post("https://ems-api.litdevs.org/v1/pm2/spacespull", {
		token: token,
		appName: environment
	}).then((res) => {
		console.log(res.data);
	});
//})
