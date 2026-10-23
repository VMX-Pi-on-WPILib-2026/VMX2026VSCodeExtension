#!/usr/bin/env node
// End-to-end check of packaged releases with a real Gradle, without GitHub or a robot:
//   node tools/smoke_release.js <gradlerio release dir> <allwpilib release dir>
// Each release dir holds vmx2026.json and its ZIP(s) (tools/package_release.py output).
// Installs both through the extension's install code into ~/wpilib/2026/VMX2026, creates
// WPILib 2026 Java and C++ projects from the template in a temporary folder, switches them to
// VMX-Pi and back to RoboRIO and builds each time. Run `npm run compile` first.
// Env: GRADLE_USER_HOME is passed through; SKIP_CPP=1 skips the C++ project; KEEP=1 keeps the projects.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Response } = require('node-fetch');
const { installComponent, validateManifest, manifestAssetName } = require('../out/releases');
const { configureProject, defaultHome, projectStorageDir } = require('../out/project');

const [gradlerioDir, allwpilibDir] = process.argv.slice(2);
if (!gradlerioDir || !allwpilibDir) { console.error('usage: smoke_release.js <gradlerio release dir> <allwpilib release dir>'); process.exit(2); }

async function install(component, dir) {
    const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(dir, manifestAssetName), 'utf8')), component);
    const names = [manifest.archive, ...(manifest.additionalArchives || []).map(part => part.archive)];
    const repository = 'VMXONWPI/' + (component === 'gradlerio' ? 'GradleRIO' : 'allwpilib');
    const release = { tag_name: 'v' + manifest.version, draft: false, prerelease: true, assets: names.map(name => ({ name,
        size: fs.statSync(path.join(dir, name)).size,
        browser_download_url: 'https://github.com/' + repository + '/releases/download/v' + manifest.version + '/' + name })) };
    const download = async url => new Response(fs.createReadStream(path.join(dir, url.slice(url.lastIndexOf('/') + 1))));
    return installComponent({ repository, release, manifest }, defaultHome(), text => console.log(text), download);
}

function project(language) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmx2026 smoke ' + language + ' '));
    const cpp = language === 'cpp';
    fs.writeFileSync(path.join(dir, 'build.gradle'), `plugins {
    id "${cpp ? 'cpp' : 'java'}"
    id "edu.wpi.first.GradleRIO" version "2026.2.2"
}
deploy {
    targets {
        roborio(getTargetTypeClass('RoboRIO')) {
            team = project.frc.getTeamNumber()
            debug = project.frc.getDebugOrDefault(false)
            artifacts {
                ${cpp ? "frcCpp(getArtifactTypeClass('FRCNativeArtifact'))" : "frcJava(getArtifactTypeClass('FRCJavaArtifact'))"} {
                }
                frcStaticFileDeploy(getArtifactTypeClass('FileTreeArtifact')) {
                    files = project.fileTree('src/main/deploy')
                    directory = '/home/lvuser/deploy'
                }
            }
        }
    }
}
def deployArtifact = deploy.targets.roborio.artifacts.${cpp ? 'frcCpp' : 'frcJava'}
${cpp ? `model {
    components {
        frcUserProgram(NativeExecutableSpec) {
            targetPlatform wpi.platforms.roborio
            sources.cpp { source { srcDir 'src/main/cpp' } }
            deployArtifact.component = it
            wpi.cpp.enableExternalTasks(it)
            wpi.cpp.deps.wpilib(it)
        }
    }
}` : `java { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
dependencies {
    implementation wpi.java.deps.wpilib()
    roborioDebug wpi.java.deps.wpilibJniDebug(wpi.platforms.roborio)
    roborioRelease wpi.java.deps.wpilibJniRelease(wpi.platforms.roborio)
}
jar {
    from { configurations.runtimeClasspath.collect { it.isDirectory() ? it : zipTree(it) } }
    manifest edu.wpi.first.gradlerio.GradleRIOPlugin.javaManifest('frc.robot.Main')
    duplicatesStrategy = DuplicatesStrategy.INCLUDE
}
deployArtifact.jarTask = jar
// Prints the HAL JNI zip resolved for the current target.
tasks.register('printHalJni') { doLast {
    def name = configurations.findByName('vmxRelease') ? 'vmxRelease' : 'roborioRelease'
    configurations.getByName(name).files.findAll { it.name.startsWith('hal-cpp') }.each { println 'HALJNI ' + it.name }
} }`}
`);
    fs.writeFileSync(path.join(dir, 'settings.gradle'), "rootProject.name = 'smoke'\n");
    fs.mkdirSync(path.join(dir, '.wpilib'));
    fs.writeFileSync(path.join(dir, '.wpilib/wpilib_preferences.json'), '{"currentLanguage":"' + language + '","projectYear":"2026","teamNumber":1234}');
    if (cpp) {
        fs.mkdirSync(path.join(dir, 'src/main/cpp'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src/main/cpp/Robot.cpp'), `#include <frc/TimedRobot.h>
class Robot : public frc::TimedRobot {};
int main() { return frc::StartRobot<Robot>(); }
`);
    } else {
        fs.mkdirSync(path.join(dir, 'src/main/java/frc/robot'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src/main/java/frc/robot/Main.java'), `package frc.robot;
import edu.wpi.first.wpilibj.RobotBase;
import edu.wpi.first.wpilibj.TimedRobot;
public final class Main {
    static class Robot extends TimedRobot {}
    public static void main(String... args) { RobotBase.startRobot(Robot::new); }
}
`);
    }
    // The Gradle wrapper of the GradleRIO checkout next to this repository.
    const gradlerio = path.resolve(__dirname, '../../GradleRIO');
    fs.copyFileSync(path.join(gradlerio, 'gradlew'), path.join(dir, 'gradlew'));
    fs.chmodSync(path.join(dir, 'gradlew'), 0o755);
    fs.cpSync(path.join(gradlerio, 'gradle'), path.join(dir, 'gradle'), { recursive: true });
    return dir;
}

function gradle(dir, args) {
    console.log('$ gradlew ' + args.join(' '));
    const result = spawnSync('sh', ['gradlew', '--console=plain', ...args], { cwd: dir, encoding: 'utf8', env: process.env });
    const out = (result.stdout || '') + (result.stderr || '');
    if (result.status !== 0) { console.log(out); throw new Error('Gradle failed: ' + args.join(' ')); }
    return out;
}

(async () => {
    const installation = { gradlerio: await install('gradlerio', gradlerioDir), allwpilib: await install('allwpilib', allwpilibDir) };
    const projects = [];
    try {
        const java = project('java');
        projects.push(java);
        await configureProject(java, installation, 'vmx');
        let out = gradle(java, ['jar', 'printHalJni']);
        if (!out.includes('HALJNI hal-cpp-' + installation.allwpilib.manifest.version + '-linuxarm64.zip')) { throw new Error('VMX Java did not resolve the VMX HAL JNI'); }
        console.log('ok: Java on VMX-Pi uses hal-cpp ' + installation.allwpilib.manifest.version + ' linuxarm64');
        if (installation.allwpilib.manifest.robotLibraries) {
            const source = path.join(java, 'src/main/java/frc/robot/Main.java');
            const original = fs.readFileSync(source, 'utf8');
            fs.writeFileSync(source, original.replace('static class Robot extends TimedRobot {}', `static class Robot extends TimedRobot {
                private final com.studica.frc.TitanQuad motor = new com.studica.frc.TitanQuad(42, 0);
                private final com.studica.frc.TitanQuadEncoder encoder = new com.studica.frc.TitanQuadEncoder(motor, 0, 0.001);
                public void teleopPeriodic() { motor.set(0.25); }
                public void disabledInit() { motor.stopMotor(); }
            }`));
            gradle(java, ['jar']);
            console.log('ok: Java Studica TitanQuad and TitanQuadEncoder compile from the installed robot libraries');
            fs.writeFileSync(source, original);
        }
        await configureProject(java, installation, 'roborio');
        out = gradle(java, ['jar', 'printHalJni']);
        if (!out.includes('HALJNI hal-cpp-' + installation.allwpilib.manifest.version + '-linuxathena.zip')) { throw new Error('RoboRIO Java did not resolve the upstream athena HAL'); }
        console.log('ok: Java back on RoboRIO uses the upstream athena HAL from the same repository');

        if (process.env.SKIP_CPP !== '1') {
            const cpp = project('cpp');
            projects.push(cpp);
            await configureProject(cpp, installation, 'vmx');
            if (installation.allwpilib.manifest.robotLibraries) {
                const source = path.join(cpp, 'src/main/cpp/Robot.cpp');
                fs.writeFileSync(source, `#include <frc/TimedRobot.h>
#include <studica/TitanQuad.h>
#include <studica/TitanQuadEncoder.h>
class Robot : public frc::TimedRobot {
    studica::TitanQuad motor{42, 0};
    studica::TitanQuadEncoder encoder{motor, 0, 0.001};
    void TeleopPeriodic() override { motor.Set(0.25); }
    void DisabledInit() override { motor.StopMotor(); }
};
int main() { return frc::StartRobot<Robot>(); }
`);
            }
            // A single target platform, so Gradle leaves it out of task names and paths.
            gradle(cpp, ['installFrcUserProgramReleaseExecutable']);
            const lib = path.join(cpp, 'build/install/frcUserProgram/release/lib/libwpiHal.so');
            if (!fs.readFileSync(lib).includes('libvmxpi_hal_cpp.so')) { throw new Error('C++ program does not use the VMX HAL'); }
            console.log('ok: C++ on VMX-Pi links the VMX HAL');
        }
        console.log('SMOKE OK');
    } finally {
        for (const dir of process.env.KEEP === '1' ? [] : projects) {
            fs.rmSync(projectStorageDir(dir), { recursive: true, force: true });
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
})().catch(error => { console.error('SMOKE FAILED: ' + error.message); process.exit(1); });
