import { CommonModule } from '@angular/common';
import {
  Component,
  Inject,
  OnInit,
} from '@angular/core';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import {
  catchError,
  map,
} from 'rxjs/operators';

import { SearchManager } from '../../../../../core/browse/search-manager';
import { DSpaceObject } from '../../../../../core/shared/dspace-object.model';
import { Item } from '../../../../../core/shared/item.model';
import { CrisLayoutBox } from '../../../../../core/layout/models/box.model';
import { PaginatedSearchOptions } from '../../../../../shared/search/models/paginated-search-options.model';
import { PaginationComponentOptions } from '../../../../../shared/pagination/pagination-component-options.model';
import { CrisLayoutBoxModelComponent } from '../../../../models/cris-layout-box-component.model';
import {
  getFirstCompletedRemoteData,
} from '../../../../../core/shared/operators';

interface CollaborationNode {
  id: string;
  name: string;
  count: number;
  x: number;
  y: number;
}

interface CollaborationLink {
  source: string;
  target: string;
  count: number;
}

@Component({
  selector: 'ds-cris-layout-collaboration-network-box',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './cris-layout-collaboration-network-box.component.html',
  styleUrls: ['./cris-layout-collaboration-network-box.component.scss'],
})
export class CrisLayoutCollaborationNetworkBoxComponent
  extends CrisLayoutBoxModelComponent
  implements OnInit {

  nodes: CollaborationNode[] = [];
  links: CollaborationLink[] = [];

  loading = true;
  hasCollaborators = false;

  constructor(
    protected translateService: TranslateService,
    protected searchManager: SearchManager,
    protected router: Router,
    @Inject('boxProvider') public boxProvider: CrisLayoutBox,
    @Inject('itemProvider') public itemProvider: Item,
  ) {
    super(translateService, boxProvider, itemProvider);
  }

  ngOnInit(): void {
    super.ngOnInit();

    this.loadNetwork().subscribe({
      next: (result) => {
        this.nodes = result.nodes;
        this.links = result.links;
        this.hasCollaborators = this.nodes.length > 1;
        this.loading = false;
      },
      error: () => {
        this.nodes = [];
        this.links = [];
        this.loading = false;
        this.hasCollaborators = false;
      },
    });
  }

  /**
   * Load the exact same publication set used by the native
   * Publications RELATION box.
   *
   * Native configuration:
   * RELATION.Person.researchoutputs
   *
   * Native scope:
   * scope=<person UUID>
   */
  private loadNetwork(): Observable<{
    nodes: CollaborationNode[];
    links: CollaborationLink[];
  }> {
    const person = this.item;

    const searchOptions = new PaginatedSearchOptions({
      configuration: 'RELATION.Person.researchoutputs',
      scope: person.uuid,
      pagination: (() => {
        const pagination = new PaginationComponentOptions();
        pagination.id = 'collaboration-network';
        pagination.pageSize = 100;
        pagination.currentPage = 1;
        return pagination;
      })(),
    });

    return this.searchManager.search<DSpaceObject>(
      searchOptions,
      undefined,
      true,
      true,
    ).pipe(
      getFirstCompletedRemoteData(),
      map((results) => {
        const publications = (results.payload?.page || [])
          .map((result: any) => result.indexableObject)
          .filter((item: Item) => !!item);

        return this.buildNetworkFromPublications(person, publications);
      }),
      catchError(() => of(this.createPersonOnlyNode(person))),
    );
  }

  /**
   * Build the collaboration graph from publication author metadata.
   *
   * We inspect the author metadata on each publication instead of
   * relying on the relationship table, because the Publications
   * Discovery configuration already provides the correct publication
   * scope for the Person.
   */
  private buildNetworkFromPublications(
    person: Item,
    publications: Item[],
  ): {
    nodes: CollaborationNode[];
    links: CollaborationLink[];
  } {
    if (publications.length === 0) {
      return this.createPersonOnlyNode(person);
    }

    const collaborationMap = new Map<string, {
      name: string;
      count: number;
      uuid?: string;
    }>();

    publications.forEach((publication) => {
      const authors = this.getPublicationAuthors(publication);

      authors.forEach((author) => {
        const authorKey = author.uuid || author.name;

        if (!authorKey || authorKey === person.uuid) {
          return;
        }

        const existing = collaborationMap.get(authorKey);

        if (existing) {
          existing.count++;
        } else {
          collaborationMap.set(authorKey, {
            name: author.name,
            count: 1,
            uuid: author.uuid,
          });
        }
      });
    });

    return this.buildGraph(person, collaborationMap);
  }

  /**
   * Extract authors from a publication.
   *
   * DSpace-CRIS can expose authors as metadata values. When an
   * authority UUID is present we retain it so the researcher node
   * can link to the corresponding Person profile.
   */
  private getPublicationAuthors(
    publication: Item,
  ): Array<{ name: string; uuid?: string }> {
    const metadata = publication.metadata || {};

    const possibleKeys = [
      'dc.contributor.author',
      'cris.author',
      'oairecerif.author',
    ];

    for (const key of possibleKeys) {
      const values = metadata[key];

      if (!values || values.length === 0) {
        continue;
      }

      return values
        .map((value: any) => ({
          name: value?.value || '',
          uuid: value?.authority || undefined,
        }))
        .filter((author) => author.name);
    }

    return [];
  }

  private buildGraph(
    person: Item,
    collaborationMap: Map<string, {
      name: string;
      count: number;
      uuid?: string;
    }>,
  ): {
    nodes: CollaborationNode[];
    links: CollaborationLink[];
  } {
    const collaborators = Array.from(collaborationMap.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 30);

    const centerX = 400;
    const centerY = 250;

    const nodes: CollaborationNode[] = [
      {
        id: person.uuid,
        name: this.getItemName(person),
        count: 0,
        x: centerX,
        y: centerY,
      },
    ];

    const links: CollaborationLink[] = [];

    collaborators.forEach(([key, data], index) => {
      const angle = (2 * Math.PI * index) / Math.max(collaborators.length, 1);
      const radius = 180;
      const id = data.uuid || key;

      nodes.push({
        id,
        name: data.name,
        count: data.count,
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
      });

      links.push({
        source: person.uuid,
        target: id,
        count: data.count,
      });
    });

    return {
      nodes,
      links,
    };
  }

  private createPersonOnlyNode(person: Item): {
    nodes: CollaborationNode[];
    links: CollaborationLink[];
  } {
    return {
      nodes: [{
        id: person.uuid,
        name: this.getItemName(person),
        count: 0,
        x: 400,
        y: 250,
      }],
      links: [],
    };
  }

  private getItemName(item: Item): string {
    return item.firstMetadataValue('dc.title')
      || item.firstMetadataValue('crisrp.name')
      || item.name
      || 'Unknown researcher';
  }

  getNode(id: string): CollaborationNode | undefined {
    return this.nodes.find((node) => node.id === id);
  }

  openPerson(uuid: string): void {
    this.router.navigate(['/entities/person', uuid]);
  }
}
