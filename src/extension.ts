// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { cpSync } from 'fs';
import * as vscode from 'vscode';

interface Filter {
	"name": string,
	"options": string[],
}

interface DimensionOption {
	"Key": string,
	"Title": string
}

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "statlinebrowser" is now active!');

	const configuration =- vscode.workspace.getConfiguration("statlinebrowser");

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider("mainPanel", {
            async resolveWebviewView(webviewView: vscode.WebviewView, resolveContext: vscode.WebviewViewResolveContext, token: vscode.CancellationToken) {
				console.log("Resolve WebviewView called for main panel");

				webviewView.webview.options = {
					"enableScripts": true
				};

				const mainPanelHTMLContent = await getHtmlContent(context, "mainPanel.html");

				webviewView.webview.html = mainPanelHTMLContent;

				// Message handler (for table fetching)
				const messageHandler = webviewView.webview.onDidReceiveMessage(async (message) => {
					switch(message.command) {
						case "DOMContentLoaded":
							console.log("DOM content loaded for main panel");
							const lastTableId = context.workspaceState.get<string>("lastTableId");

							if (lastTableId) {
								webviewView.webview.postMessage({
									command: "setTableId",
									value: lastTableId
								});

							}

							const filters = context.workspaceState.get<string>("lastFilters");

							if (filters) {
								console.log("Sending message!")
								webviewView.webview.postMessage({
									command: "renderFilters",
									filters: filters
								});
							}
							
							// Inside case "DOMContentLoaded":
							const savedSelectedFilters = context.workspaceState.get<Record<string, string[]>>("lastSelectedFilters");
							if (savedSelectedFilters) {
								webviewView.webview.postMessage({
									command: "setSelectedFilters",
									selectedFilters: savedSelectedFilters
								});
							}
							return;
						case "fetchOptions":
							if (!message.tableId) {
								console.log("Received Fetch Table without table id!");
							}
							
							await context.workspaceState.update("lastTableId", message.tableId);
							console.log(`TableID after setting workspace state: ${context.workspaceState.get<string>("lastTableId")}`);

							console.log(`User wants to display table with ID: ${message.tableId}`);
							console.log(`First fetching catalog data on table...`);

							const dataProperties = await getCBSTableDataProperties(message.tableId);

							console.log(`CBS Table info: ${dataProperties}`);

							const dimensions = dataProperties.filter((p: any) => p["odata.type"] === "Cbs.OData.Dimension");
							const timeDimensions = dataProperties.filter((p: any) => p["odata.type"] === "Cbs.OData.TimeDimension");
							console.log(`Dimensions: ${dimensions}`);
							console.log(`TimeDimensions: ${timeDimensions}`);

							const allDimensions = [...timeDimensions, ...dimensions];

							const newFilters: Filter[] = await Promise.all(
								allDimensions.map(async (dimension) => ({
									name: dimension.Key,
									options: await getCBSTableDimensionOptions(message.tableId, dimension.Key)
								}))
							);

							await context.workspaceState.update("lastFilters", newFilters);

							webviewView.webview.postMessage({
								command: "renderFilters",
								filters: newFilters
							});
							return;
						case "fetchTable":
							console.log(`Fetching Statline table with ID ${message.tableId}`);
							console.log(`Filters: ${JSON.stringify(message.selectedFilters)}`);
							const rows = await fetchCBSTableData(message.tableId, message.selectedFilters);
							
							if (rows && rows.length > 0) {
								// Generate table headers from the keys of the first row object
								const headers = Object.keys(rows[0]);
								const headerHtml = `<tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>`;
								
								// Generate table rows
								const rowHtml = rows.map((row: any) => 
									`<tr>${headers.map(h => `<td>${row[h] !== undefined ? row[h] : ''}</td>`).join('')}</tr>`
								).join('');

								const tableHtml = `<table><thead>${headerHtml}</thead><tbody>${rowHtml}</tbody></table>`;

								// Send back to webview
								webviewView.webview.postMessage({
									command: "renderTable",
									html: tableHtml
								});
							} else {
								webviewView.webview.postMessage({
									command: "renderTable",
									html: "<p>No data returned for the selected filters.</p>"
								});
							}
							return;
						case "saveSelectedFilters":
							console.log("Saving selected filters");
							await context.workspaceState.update("lastSelectedFilters", message.selectedFilters);
							return;
					}
				});

				// Clean up the message listener when the view is disposed
                webviewView.onDidDispose(() => {
                    messageHandler.dispose();
                }, null, context.subscriptions);
			}
		})
	);
};


async function getCBSTableDataProperties(tableId: string) {
    // Note: The TableInfos endpoint uses single quotes for the ID
    const url = `https://opendata.cbs.nl/ODataApi/OData/${tableId}/DataProperties`;

	console.log(`Constructed url: ${url}`)
    
    try {
        const response = await fetch(url);

		if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

		console.log(`Response: ${response}`)
        const data = await response.json() as any;        
        if (data && data.value && data.value.length > 0) {
			const tableData = data.value;
			console.log(`Table data: ${tableData}`);
			return tableData;
		} else {
			console.warn("Table data not found or empty.");
			throw new Error("Table Info is Empty!");
		}
    } catch (e) {
        console.error("Failed to fetch table info", e);
    }
}

async function getCBSTableDimensionOptions(tableId: string, key: string): Promise<string[]> {
	const url = `https://opendata.cbs.nl/ODataApi/OData/${tableId}/${key}`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json() as any;
        
        if (data && data.value && data.value.length > 0) {
			return data.value.map((option: DimensionOption) => `${option.Key}: ${option.Title}`);
		} else {
			console.warn("Table data not found or empty.");
			throw new Error("Table Info is Empty!");
		}
    } catch (error) {
        console.error("Failed to fetch CBS data:", error);
		return [];
    }
}

function buildODataFilter(selectedFilters: Record<string, string[]>): string {
    const filterClauses: string[] = [];

    for (const [dimensionKey, values] of Object.entries(selectedFilters)) {
        if (values && values.length > 0) {
            // Create an 'or' condition for options selected within the same dimension
            // e.g., (Geslacht eq 'A' or Geslacht eq 'B')
            const innerClauses = values.map(val => `${dimensionKey} eq '${val.replace(' ', '')}'`).join(' or ');
            filterClauses.push(`(${innerClauses})`);
        }
    }

    // Join different dimensions with 'and'
    return filterClauses.length > 0 ? `$filter=${filterClauses.join(' and ')}` : '';
}

async function fetchCBSTableData(tableId: string, selectedFilters: Record<string, string[]>) {
	const filterQuery = buildODataFilter(selectedFilters);
    
    // We create a helper to build the URL cleanly
    const buildUrl = (withTop: boolean) => {
        const params = [];
        if (withTop) params.push(`$top=100`);
        if (filterQuery) params.push(filterQuery);
        return `https://opendata.cbs.nl/ODataApi/OData/${tableId}/UntypedDataSet?${params.join('&')}`;
    };

    // 1. Try fetching WITHOUT top=100 first (or with it, depending on your goal)
    const url = buildUrl(false);
    console.log(`Fetching from: ${url}`);

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP: ${response.status}`);
        const data = await response.json()as any;
		console.log(`Succeeded!`)
        return data.value;
    } catch (error) {
        // 2. Retry with top=100 if the first fetch fails
        console.warn("Primary fetch failed, retrying with $top=100...");
        
        const retryUrl = buildUrl(true);
        console.log(`Retrying for: ${retryUrl}`);
        
        try {
            const retryResponse = await fetch(retryUrl);
            if (!retryResponse.ok) throw new Error(`Retry HTTP: ${retryResponse.status}`);
            const retryData = await retryResponse.json() as any;
			console.log(`Succeeded!`)
            return retryData.value;
        } catch (retryError) {
            console.error("Critical failure on retry:", retryError);
            return [];
        }
    }

}
async function getHtmlContent(context: vscode.ExtensionContext, fileName: string): Promise<string> {
    // Construct the path to your assets file
    const filePath = vscode.Uri.joinPath(context.extensionUri, 'assets', fileName);
    
    // Read file using VS Code's FS API
    const fileData = await vscode.workspace.fs.readFile(filePath);
    
    // Convert Uint8Array to string
    return new TextDecoder().decode(fileData);
};

// This method is called when your extension is deactivated
export function deactivate() {};
