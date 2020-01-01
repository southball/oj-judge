const fs = require("fs");
const process = require("child_process");
const path = require("path");
const request = require("request-promise-native");
const url = require("url");
const util = require("util");
const moment = require("moment");
const judgeConfig = require("./config.json");

log = (message, ...args) => {
  console.log("[%s] " + message, moment().format("YYYY-MM-DD hh:mm:ss"), ...args);
};

const genUrl = (...parts) =>
  parts.reduce((cur, part) => {
    return url.resolve(cur.endsWith("/") ? cur : cur + "/", part);
  }, judgeConfig.server_root);

const api = (relUrl, body = {}, config = {}) =>
  request(genUrl(relUrl), {
    json: true,
    body: {
      ...judgeConfig,
      ...body
    },
    ...config
  });

async function runProcess(cmd, trim = true) {
  return new Promise((resolve, reject) => {
    process.exec(cmd, {}, (error, stdout, stderr) => {
      resolve([trim ? stdout.trim() : stdout, trim ? stderr.trim() : stderr]);
    });
  });
}

async function judgeServer() {
  await runProcess("isolate --cg --cleanup");
  const [sandboxPath] = await runProcess("isolate --cg --init");

  log(`Sandbox initialized in ${sandboxPath}.`);

  fs.writeFileSync(
    path.resolve(sandboxPath, "box", "test.cpp"),
    `
  #include <iostream>
  using namespace std;

  int main() {
    cout << "Hello, world!" << endl;
  }
  `
  );

  await runProcess(
    "isolate --cg --mem=256000 --time=30 --wall-time=45 --full-env --processes=0 --run -- /usr/bin/g++ -o test test.cpp"
  );
  const [stdout] = await runProcess("isolate --cg --mem=256000 --time=1 --run test");

  log(stdout);
}

async function initSandbox() {
  await runProcess("isolate --cg --cleanup");
  const [sandboxPath] = await runProcess("isolate --cg --no-cg-timing --init");

  return sandboxPath;
}

async function loop() {
  try {
    await api("judger/ping");
    log("Pinged.");

    const job = await api("judger/get");
    log("Job checked. ID = %d", job.id);

    if (job.id) {
      log("Job %d received.", job.id);
      const sandboxPath = await initSandbox();
      log("Sandbox initialized at %s", sandboxPath);
      const resolveSandbox = location => path.resolve(sandboxPath, "box", location);

      log("Fetching test case input.");
      const testcaseInput = (
        await api(
          "judger/file",
          {
            file: `${job.submission.problem.id}/testcases.txt`
          },
          { encoding: null }
        )
      ).toString("utf8");
      log("Fetched test case input.");

      log("Test case input file:\n%s", testcaseInput);
      const testcases = testcaseInput
        .split("\n")
        .filter(x => x.length)
        .map(x => x.trim().split(" "))
        .filter(x => x.length);
      log("Testcases: %s", JSON.stringify(testcases));

      log("Number of test cases: %d", testcases.length);

      const language = job.submission.language;
      const code = job.submission.body;

      const tests = {};

      /**
       * The current verdict for the whole submission.
       */
      let verdict = "WJ";

      for (const [infile] of testcases) {
        tests[infile] = { verdict: "WJ", message: "" };
      }

      // Set initial status.
      log("Setting initial status.");
      await api("judger/set", {
        id: job.id,
        judgeOutput: JSON.stringify({ tests })
      });

      // Compile checker.
      log("Compiling checker.");
      const writeFile = util.promisify(fs.writeFile);
      const readFile = util.promisify(fs.readFile);

      console.log("Download resource/checker.cpp to %s", resolveSandbox("checker.cpp"));
      await writeFile(resolveSandbox("checker.cpp"), await api("judger/file", { file: "resource/checker.cpp" }));
      await writeFile(resolveSandbox("testlib.h"), await api("judger/file", { file: "resource/testlib.h" }));
      await runProcess(
        "isolate --cg --mem=256000 --time=30 --wall-time=45 --full-env --processes=0 --run -- /usr/bin/g++ -o checker checker.cpp"
      );

      if (fs.existsSync(resolveSandbox("checker"))) {
        log("Checker compiled.");
      } else {
        await api("judger/set", {
          id: job.id,
          verdict: "IE",
          judgeOutput: JSON.stringify({
            tests,
            message: "Error when compiling the checker."
          })
        });
        throw new Error();
      }

      // Compile process.
      if (language === "cpp") {
        log("Compiling C++ program");
        await writeFile(resolveSandbox("program.cpp"), code);
        try {
          await runProcess(
            "isolate --silent --cg --mem=256000 --time=30 --wall-time=45 --full-env --stderr compile.out --processes=0 --run -- /usr/bin/g++ -o program program.cpp"
          );
          if (fs.existsSync(resolveSandbox("program"))) {
            log("Compiled C++ program.");
          } else {
            throw new Error();
          }
        } catch (exception) {
          log("Error while compiling C++ program.");
          await api("judger/set", {
            id: job.id,
            verdict: "CE",
            judgerOutput: JSON.stringify({
              tests,
              message: (await readFile(resolveSandbox("compile.out"))).toString("utf8")
            })
          });
          throw new Error();
        }
      } else if (language === "py3") {
        // Do nothing
      } else {
        await api("judger/set", {
          verdict: "IE",
          judgerOutput: {
            message: "The language is not supported."
          }
        });
        throw new Error();
      }

      // Process the test cases one by one.
      log("Begin processing test case.");
      for (const [infile, ansfile] of testcases) {
        log("Process test case %s, %s", infile, ansfile);
        log("Download %s to %s...", `${job.submission.problem.id}/${infile}`, resolveSandbox("in"));
        await writeFile(
          resolveSandbox("in"),
          await api("judger/file", {
            file: `${job.submission.problem.id}/${infile}`
          })
        );

        let caseVerdict = "AC";
        const meta = resolveSandbox("meta");
        if (language === "cpp") {
          await runProcess(`isolate --cg --meta="${meta}" --mem=256000 --time=1 --stdin=in --stdout=out --run program`);
        } else if (language === "py3") {
        }

        log("Reading meta file...");
        const metaFile = await readFile(resolveSandbox("meta"), {
          encoding: "utf8"
        });
        const metaEntries = Object.fromEntries(
          metaFile
            .split("\n")
            .map(line => line.trim())
            .filter(line => line.length)
            .map(line => line.split(":"))
        );

        log("Meta file content:\n%s", metaFile);

        // Download answer for checker.
        log("Download %s to %s...", `${job.submission.problem.id}/${ansfile}`, resolveSandbox("ans"));
        await writeFile(
          resolveSandbox("ans"),
          await api("judger/file", {
            file: `${job.submission.problem.id}/${ansfile}`
          })
        );
        log("Running program...");

        log("Running checker...");
        const [checkerMessage] = await runProcess(
          "isolate --cg --mem=256000 --time=1 --stderr-to-stdout --run checker in out ans"
        );
        log("Test case %s: %s", infile, checkerMessage);

        const outputHeader = fs.existsSync(resolveSandbox("out"))
          ? (await readFile(resolveSandbox("out"), { encoding: "utf8" })).substr(0, 1024)
          : "";

        if (metaEntries.status === "RE") caseVerdict = "RE";
        // Not 100% sure
        else if (metaEntries.status === "SG") caseVerdict = "MLE";
        else if (metaEntries.status === "TO") caseVerdict = "TLE";

        if (caseVerdict === "AC") {
          // Read checker message
          if (!checkerMessage.startsWith("ok")) caseVerdict = "WA";
        }

        tests[infile] = {
          verdict: caseVerdict,
          meta: metaFile.trim(),
          message: checkerMessage.substr(),
          output: outputHeader,
          time: +metaEntries["time"],
          memory: +metaEntries["max-rss"]
        };

        if (caseVerdict !== "AC" && verdict === "WJ") {
          verdict = caseVerdict;
        }

        console.log("Entry: %s", JSON.stringify(tests[infile]));

        await api("judger/set", {
          id: job.id,
          verdict,
          judgerOutput: JSON.stringify({ tests })
        });
      }

      if (verdict === "WJ") verdict = "AC";

      console.log("Finished.");
      await api("judger/set", {
        id: job.id,
        verdict,
        judgerOutput: JSON.stringify({ tests })
      });

      loop();
    } else {
      setTimeout(loop, 5000);
    }
  } catch (exception) {
    console.error(exception);
    setTimeout(loop, 5000);
  }
}

loop();
