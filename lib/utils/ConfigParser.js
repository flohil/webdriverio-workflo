import fs from 'fs'
import path from 'path'
import glob from 'glob'
import merge from 'deepmerge'

import * as jsonfile from 'jsonfile'

import detectSeleniumBackend from '../helpers/detectSeleniumBackend'

const HOOKS = [
    'before', 'beforeSession', 'beforeSuite', 'beforeHook', 'beforeTest', 'beforeCommand',
    'afterCommand', 'afterTest', 'afterHook', 'afterSuite', 'afterSession', 'after',
    'beforeFeature', 'beforeScenario', 'beforeStep', 'afterFeature',
    'afterScenario', 'afterStep', 'onError', 'onReload'
]
const MERGE_OPTIONS = { clone: false }
const DEFAULT_TIMEOUT = 10000
const NOOP = function () {}
const DEFAULT_CONFIGS = {
    sync: true,
    specs: [],
    suites: {},
    exclude: [],
    logLevel: 'silent',
    coloredLogs: true,
    deprecationWarnings: true,
    baseUrl: null,
    bail: 0,
    waitforInterval: 500,
    waitforTimeout: 1000,
    framework: 'mocha',
    reporters: [],
    reporterOptions: {},
    maxInstances: 100,
    maxInstancesPerCapability: 100,
    connectionRetryTimeout: 90000,
    connectionRetryCount: 3,
    debug: false,
    execArgv: null,

    /**
     * framework defaults
     */
    mochaOpts: {
        timeout: DEFAULT_TIMEOUT
    },
    jasmineNodeOpts: {
        defaultTimeoutInterval: DEFAULT_TIMEOUT
    },

    /**
     * hooks
     */
    onPrepare: NOOP,
    before: [],
    beforeSession: [],
    beforeSuite: [],
    beforeHook: [],
    beforeTest: [],
    beforeCommand: [],
    afterCommand: [],
    afterTest: [],
    afterHook: [],
    afterSuite: [],
    afterSession: [],
    after: [],
    onComplete: NOOP,
    onError: [],
    onReload: [],

    /**
     * cucumber specific hooks
     */
    beforeFeature: [],
    beforeScenario: [],
    beforeStep: [],
    afterFeature: [],
    afterScenario: [],
    afterStep: []
}
const FILE_EXTENSIONS = ['.js', '.ts', '.feature', '.coffee', '.es6']

class ConfigParser {
    constructor () {
        this._config = DEFAULT_CONFIGS
        this._capabilities = []
    }

    /**
     * merges config file with default values
     * @param {String} filename path of file relative to current directory
     */
    addConfigFile (filename) {
        if (typeof filename !== 'string') {
            throw new Error('addConfigFile requires filepath')
        }

        var filePath = path.resolve(process.cwd(), filename)

        try {
            /**
             * clone the original config
             */
            var fileConfig = merge(require(filePath).config, {}, MERGE_OPTIONS)

            if (typeof fileConfig !== 'object') {
                throw new Error('configuration file exports no config object')
            }

            /**
             * merge capabilities
             */
            const defaultTo = Array.isArray(this._capabilities) ? [] : {}
            this._capabilities = merge(this._capabilities, fileConfig.capabilities || defaultTo, MERGE_OPTIONS)
            delete fileConfig.capabilities

            /**
             * add service hooks and remove them from config
             */
            this.addService(fileConfig)
            for (let hookName of HOOKS) {
                delete fileConfig[hookName]
            }

            this._config = merge(this._config, fileConfig, MERGE_OPTIONS)

            /**
             * detect Selenium backend
             */
            this._config = merge(detectSeleniumBackend(this._config), this._config, MERGE_OPTIONS)
        } catch (e) {
            console.error(`Failed loading configuration file: ${filePath}`)
            throw e
        }
    }

    /**
     * merge external object with config object
     * @param  {Object} object  desired object to merge into the config object
     */
    merge (object = {}) {
        this._config = merge(this._config, object, MERGE_OPTIONS)

        if (typeof this._config.reporterOptions === 'string') {
            this._config.reporterOptions = JSON.parse(object.reporterOptions)
        }

        if (object.testInfoFilePath) {
            if (fs.existsSync(object.testInfoFilePath)) {
                this.testinfo = jsonfile.readFileSync(object.testInfoFilePath)
            }
        }

        if (this.testinfo) {
            this._config = merge(this._config, this.testinfo)
        }

        if (this._config.executionFilters) {
            /**
             * Run selected spec files only
             */
            if (typeof this._config.executionFilters.specFiles !== 'undefined') {
                const specs = []

                for (let spec in this._config.executionFilters.specFiles) {
                    if (fs.existsSync(spec)) {
                        specs.push(spec)
                    } else {
                        throw new Error(`Spec file ${spec} not found`)
                    }
                }

                this._config.specs = specs
            }

            if (typeof this._config.executionFilters.testcaseFiles !== 'undefined') {
                const testcases = []

                for (let testcase in this._config.executionFilters.testcaseFiles) {
                    if (fs.existsSync(testcase)) {
                        testcases.push(testcase)
                    } else {
                        throw new Error(`Testcase file ${testcase} not found`)
                    }
                }

                this._config.testcases = testcases
            }

            if (typeof this._config.executionFilters.manualResultFiles !== 'undefined') {
                const manualResults = []

                for (let manualResult in this._config.executionFilters.manualResultFiles) {
                    if (fs.existsSync(manualResult)) {
                        manualResults.push(manualResult)
                    } else {
                        throw new Error(`Manual result file ${manualResult} not found`)
                    }
                }

                this._config.manualResults = manualResults
            }
        }

        /**
         * user and key could get added via cli arguments so we need to detect again
         * Note: cli arguments are on the right and overwrite config
         * if host and port are default, remove them to get new values
         */
        let defaultBackend = detectSeleniumBackend({})
        if (this._config.host === defaultBackend.host && this._config.port === defaultBackend.port) {
            delete this._config.host
            delete this._config.port
        }

        this._config = merge(detectSeleniumBackend(this._config), this._config, MERGE_OPTIONS)
    }

    /**
     * add hooks from services to runner config
     * @param {Object} service  a service is basically an object that contains hook methods
     */
    addService (service) {
        for (let hookName of HOOKS) {
            if (!service[hookName]) {
                continue
            } else if (typeof service[hookName] === 'function') {
                this._config[hookName].push(service[hookName].bind(service))
            } else if (Array.isArray(service[hookName])) {
                for (let hook of service[hookName]) {
                    if (typeof hook === 'function') {
                        this._config[hookName].push(hook.bind(service))
                    }
                }
            }
        }
    }

    /**
     * get excluded files from config pattern
     */
    getTestcases (capTestcases, capExclude) {
        let testcases = ConfigParser.getFilePaths(this._config.testcases)
        let exclude = ConfigParser.getFilePaths(this._config.exclude)

        /**
         * check if user has specified a specific suites to run
         */
        // TODO: use suites for specs, find relevant testcases by parsing...
        // let suites = typeof this._config.suite === 'string' ? this._config.suite.split(',') : []
        // if (Array.isArray(suites) && suites.length > 0) {
        //     let suiteTestcases = []
        //     for (let suiteName of suites) {
        //         // ToDo: log warning if suite was not found
        //         let suite = this._config.suites[suiteName]
        //         if (suite && Array.isArray(suite)) {
        //             suiteTestcases = suiteTestcases.concat(ConfigParser.getFilePaths(suite))
        //         }
        //     }

        //     if (suiteTestcases.length === 0) {
        //         throw new Error(`The suite(s) "${suites.join('", "')}" you specified don't exist ` +
        //                         'in your config file or doesn\'t contain any files!')
        //     }

        //     testcases = suiteTestcases
        // }

        if (Array.isArray(capTestcases)) {
            testcases = testcases.concat(ConfigParser.getFilePaths(capTestcases))
        }
        if (Array.isArray(capExclude)) {
            exclude = exclude.concat(ConfigParser.getFilePaths(capExclude))
        }

        return testcases.filter(testcase => exclude.indexOf(testcase) < 0)
    }

    getManualResults (capTestcases, capExclude) {
        let manualResults = ConfigParser.getFilePaths(this._config.manualResults)
        let exclude = ConfigParser.getFilePaths(this._config.exclude)

        if (Array.isArray(capTestcases)) {
            manualResults = manualResults.concat(ConfigParser.getFilePaths(capTestcases))
        }
        if (Array.isArray(capExclude)) {
            exclude = exclude.concat(ConfigParser.getFilePaths(capExclude))
        }

        return manualResults.filter(manualResult => exclude.indexOf(manualResult) < 0)
    }

    /**
     * get excluded files from config pattern
     */
    getSpecs (capSpecs, capExclude) {
        let specs = ConfigParser.getFilePaths(this._config.specs)
        let exclude = ConfigParser.getFilePaths(this._config.exclude)

        /**
         * check if user has specified a specific suites to run
         */
        let suites = typeof this._config.suite === 'string' ? this._config.suite.split(',') : []
        if (Array.isArray(suites) && suites.length > 0) {
            let suiteSpecs = []
            for (let suiteName of suites) {
                // ToDo: log warning if suite was not found
                let suite = this._config.suites[suiteName]
                if (suite && Array.isArray(suite)) {
                    suiteSpecs = suiteSpecs.concat(ConfigParser.getFilePaths(suite))
                }
            }

            if (suiteSpecs.length === 0) {
                throw new Error(`The suite(s) "${suites.join('", "')}" you specified don't exist ` +
                                'in your config file or doesn\'t contain any files!')
            }

            specs = suiteSpecs
        }

        if (Array.isArray(capSpecs)) {
            specs = specs.concat(ConfigParser.getFilePaths(capSpecs))
        }
        if (Array.isArray(capExclude)) {
            exclude = exclude.concat(ConfigParser.getFilePaths(capExclude))
        }

        return specs.filter(spec => exclude.indexOf(spec) < 0)
    }

    /**
     * return configs
     */
    getConfig () {
        return this._config
    }

    /**
     * return capabilities
     */
    getCapabilities (i) {
        if (typeof i === 'number' && this._capabilities[i]) {
            return this._capabilities[i]
        }

        return this._capabilities
    }

    /**
     * returns a flatten list of globed files
     *
     * @param  {String[]} filenames  list of files to glob
     * @return {String[]} list of files
     */
    static getFilePaths (patterns, omitWarnings) {
        let files = []

        if (typeof patterns === 'string') {
            patterns = [patterns]
        }

        if (!Array.isArray(patterns)) {
            throw new Error('specs or exclude property should be an array of strings')
        }

        for (let pattern of patterns) {
            let filenames = glob.sync(pattern)

            filenames = filenames.filter(filename => FILE_EXTENSIONS.includes(path.extname(filename)))

            filenames = filenames.map(filename =>
                path.isAbsolute(filename) ? path.normalize(filename) : path.resolve(process.cwd(), filename))

            if (filenames.length === 0 && !omitWarnings) {
                console.warn('pattern', pattern, 'did not match any file')
            }

            files = merge(files, filenames, MERGE_OPTIONS)
        }

        return files
    }
}

export default ConfigParser
